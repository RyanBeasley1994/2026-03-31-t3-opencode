import { randomUUID } from "node:crypto";
import { Buffer } from "node:buffer";

import type {
  AssistantMessage,
  Event,
  Part as OpenCodePart,
  PermissionRequest,
  QuestionAnswer,
  QuestionInfo,
  QuestionRequest,
  Session,
  ToolPart as OpenCodeToolPart,
} from "@opencode-ai/sdk/v2/client";
import {
  type ApprovalRequestId,
  type CanonicalRequestType,
  EventId,
  type ProviderApprovalDecision,
  type ProviderRuntimeEvent,
  type ProviderSession,
  type ProviderTurnStartResult,
  type ProviderUserInputAnswers,
  RuntimeItemId,
  RuntimeRequestId,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import { FileSystem, Effect, Layer, Queue, Stream } from "effect";

import { resolveAttachmentPath } from "../../attachmentStore.ts";
import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import {
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
} from "../Errors.ts";
import {
  buildOpenCodeDiffSummary,
  buildOpenCodePermissionRules,
  isPlanAgent,
  runtimeModeFromOpenCodePermissionRules,
  toCanonicalRequestType,
  toCanonicalToolItemType,
  toOpenCodeErrorMessage,
  toOpenCodeModel,
  toRuntimePlanStepStatus,
  toRuntimeTurnState,
} from "../opencodeEventMapping.ts";
import { OpenCodeAdapter, type OpenCodeAdapterShape } from "../Services/OpenCodeAdapter.ts";
import { OpenCodeServerPool, type OpenCodeServerLease } from "../Services/OpenCodeServerPool.ts";
import type { ProviderThreadSnapshot } from "../Services/ProviderAdapter.ts";

const PROVIDER = "opencode" as const;
const SDK_OPTIONS = {
  throwOnError: true as const,
};
const IDLE_COMPLETION_POLL_ATTEMPTS = 20;
const IDLE_COMPLETION_POLL_INTERVAL_MS = 100;
const USER_ABORT_ERROR_SUPPRESSION_WINDOW_MS = 5_000;

interface PendingPermissionRequest {
  readonly kind: "permission";
  readonly requestType: CanonicalRequestType;
  readonly turnId: TurnId | undefined;
  readonly itemId: RuntimeItemId | undefined;
}

interface PendingQuestionRequest {
  readonly kind: "question";
  readonly turnId: TurnId | undefined;
  readonly itemId: RuntimeItemId | undefined;
  readonly questions: ReadonlyArray<{
    readonly id: string;
    readonly multiple?: boolean;
    readonly custom?: boolean;
  }>;
}

interface KnownToolCall {
  readonly partId: string;
  readonly toolName: string;
}

interface OpenCodeSessionState {
  readonly threadId: ThreadId;
  readonly createdAt: string;
  readonly lease: OpenCodeServerLease;
  sessionId: string;
  cwd: string;
  poolRoot: string;
  binaryPath?: string;
  runtimeMode: ProviderSession["runtimeMode"];
  model: string | undefined;
  status: ProviderSession["status"];
  updatedAt: string;
  lastError: string | undefined;
  activeTurnId: TurnId | undefined;
  lastCompletedTurnId: TurnId | undefined;
  terminalTurnIds: Set<string>;
  knownPartKinds: Map<string, OpenCodePart["type"]>;
  knownToolStatuses: Map<string, OpenCodeToolPart["state"]["status"]>;
  knownToolsByCallId: Map<string, KnownToolCall>;
  pendingRequests: Map<string, PendingPermissionRequest | PendingQuestionRequest>;
  orderedUserMessageIds: Array<string>;
  abortErrorSuppressionUntil: number | undefined;
  observedTurnActivity: Map<string, number>;
  pendingIdleTurnChecks: Set<string>;
}

interface SidecarWatcher {
  readonly key: string;
  readonly abortController: AbortController;
  readonly task: Promise<void>;
  readonly ready: Promise<void>;
}

function nowIso(): string {
  return new Date().toISOString();
}

function toProviderSessionSnapshot(state: OpenCodeSessionState): ProviderSession {
  return {
    provider: PROVIDER,
    status: state.status,
    runtimeMode: state.runtimeMode,
    threadId: state.threadId,
    cwd: state.cwd,
    ...(state.model ? { model: state.model } : {}),
    resumeCursor: { sessionId: state.sessionId },
    ...(state.activeTurnId ? { activeTurnId: state.activeTurnId } : {}),
    createdAt: state.createdAt,
    updatedAt: state.updatedAt,
    ...(state.lastError ? { lastError: state.lastError } : {}),
  } satisfies ProviderSession;
}

function toRequestError(method: string, detail: string, cause?: unknown) {
  return new ProviderAdapterRequestError({
    provider: PROVIDER,
    method,
    detail,
    ...(cause !== undefined ? { cause } : {}),
  });
}

function missingSession(threadId: ThreadId) {
  return new ProviderAdapterSessionNotFoundError({
    provider: PROVIDER,
    threadId,
  });
}

function toWatcherRequestError(threadId: ThreadId, detail: string, cause?: unknown) {
  return new ProviderAdapterRequestError({
    provider: PROVIDER,
    method: "event.subscribe",
    detail,
    ...(cause !== undefined ? { cause } : {}),
  });
}

function toTurnIdForUserMessage(messageId: string): TurnId {
  return TurnId.makeUnsafe(`opencode:${messageId}`);
}

function userMessageIdFromTurnId(turnId: TurnId | string | undefined): string | undefined {
  if (!turnId) {
    return undefined;
  }
  const value = String(turnId);
  return value.startsWith("opencode:") ? value.slice("opencode:".length) : undefined;
}

function toToolItemId(callId: string): RuntimeItemId {
  return RuntimeItemId.makeUnsafe(`opencode-tool:${callId}`);
}

function toTurnIdForOpenCodeMessage(messageId: string | undefined): TurnId | undefined {
  if (!messageId || messageId.trim().length === 0) {
    return undefined;
  }
  return toTurnIdForUserMessage(messageId);
}

function readSessionIdFromResumeCursor(resumeCursor: unknown): string | undefined {
  if (!resumeCursor || typeof resumeCursor !== "object" || Array.isArray(resumeCursor)) {
    return undefined;
  }
  const record = resumeCursor as Record<string, unknown>;
  const sessionId = record.sessionId ?? record.sessionID;
  return typeof sessionId === "string" && sessionId.trim().length > 0 ? sessionId : undefined;
}

function toApprovalReply(decision: ProviderApprovalDecision): "once" | "always" | "reject" {
  switch (decision) {
    case "accept":
      return "once";
    case "acceptForSession":
      return "always";
    case "cancel":
    case "decline":
    default:
      return "reject";
  }
}

interface MappedOpenCodeQuestion {
  readonly id: string;
  readonly header: string;
  readonly question: string;
  readonly options: ReadonlyArray<{
    readonly label: string;
    readonly description: string;
  }>;
  readonly multiple?: boolean;
  readonly custom?: boolean;
}

interface RuntimeQuestionPayload {
  readonly id: string;
  readonly header: string;
  readonly question: string;
  readonly options: ReadonlyArray<{
    readonly label: string;
    readonly description: string;
  }>;
  readonly multiple?: boolean;
  readonly custom?: boolean;
}

function mapOpenCodeQuestions(
  questions: ReadonlyArray<QuestionInfo>,
): ReadonlyArray<MappedOpenCodeQuestion> {
  const headerCounts = new Map<string, number>();
  for (const question of questions) {
    headerCounts.set(question.header, (headerCounts.get(question.header) ?? 0) + 1);
  }

  const seenHeaders = new Map<string, number>();
  return questions.map((question) => {
    const seenCount = (seenHeaders.get(question.header) ?? 0) + 1;
    seenHeaders.set(question.header, seenCount);
    const headerCount = headerCounts.get(question.header) ?? 0;
    const id = headerCount > 1 ? `${question.header}#${seenCount}` : question.header;
    return {
      id,
      header: question.header,
      question: question.question,
      options: question.options,
      ...(question.multiple !== undefined ? { multiple: question.multiple } : {}),
      ...(question.custom !== undefined ? { custom: question.custom } : {}),
    };
  });
}

function toRuntimeQuestionPayload(
  questions: ReadonlyArray<MappedOpenCodeQuestion>,
): ReadonlyArray<RuntimeQuestionPayload> {
  return questions.map((question) => {
    const payloadQuestion: {
      id: string;
      header: string;
      question: string;
      options: ReadonlyArray<{
        readonly label: string;
        readonly description: string;
      }>;
      multiple?: boolean;
      custom?: boolean;
    } = {
      id: question.id,
      header: question.header,
      question: question.question,
      options: question.options,
    };
    if (question.multiple !== undefined) {
      payloadQuestion.multiple = question.multiple;
    }
    if (question.custom !== undefined) {
      payloadQuestion.custom = question.custom;
    }
    return payloadQuestion;
  });
}

function toPendingQuestionRequest(input: {
  readonly turnId: TurnId | undefined;
  readonly itemId: RuntimeItemId | undefined;
  readonly questions: ReadonlyArray<MappedOpenCodeQuestion>;
}): PendingQuestionRequest {
  return {
    kind: "question",
    turnId: input.turnId,
    itemId: input.itemId,
    questions: input.questions.map((question) => ({
      id: question.id,
      ...(question.multiple !== undefined ? { multiple: question.multiple } : {}),
      ...(question.custom !== undefined ? { custom: question.custom } : {}),
    })),
  };
}

function requestTypeForPermissionRequest(
  request: PermissionRequest,
  knownToolName: string | undefined,
): CanonicalRequestType {
  return toCanonicalRequestType({
    permission: request.permission,
    ...(knownToolName ? { toolName: knownToolName } : {}),
  });
}

function toQuestionAnswers(
  pending: PendingQuestionRequest,
  answers: ProviderUserInputAnswers,
): Array<QuestionAnswer> {
  return pending.questions.map((question) => {
    const questionId = question.id;
    const value = answers[questionId];
    if (typeof value === "string") {
      return [value];
    }
    if (Array.isArray(value)) {
      return value.filter((entry): entry is string => typeof entry === "string");
    }
    return [];
  });
}

function toUserInputAnswerRecord(
  pending: PendingQuestionRequest,
  answers: ReadonlyArray<ReadonlyArray<string>>,
): Record<string, string | ReadonlyArray<string>> {
  return Object.fromEntries(
    pending.questions.map((question, index) => {
      const questionId = question.id;
      const value = answers[index] ?? [];
      if (question.multiple) {
        return [questionId, value];
      }
      return [questionId, value.length === 1 ? value[0]! : value];
    }),
  );
}

function assistantTextFromParts(parts: ReadonlyArray<OpenCodePart>): string | undefined {
  const text = parts
    .filter((part): part is Extract<OpenCodePart, { type: "text" }> => part.type === "text")
    .map((part) => part.text)
    .join("")
    .trim();
  return text.length > 0 ? text : undefined;
}

function isTerminalAssistantMessage(message: AssistantMessage): boolean {
  const finish = message.finish;
  if (finish === "tool-calls") {
    return message.error !== undefined;
  }

  return (
    message.time.completed !== undefined || finish !== undefined || message.error !== undefined
  );
}

function summarizeToolDetail(part: OpenCodeToolPart): string | undefined {
  if (part.state.status === "completed") {
    const output = part.state.output.trim();
    if (output.length > 0) {
      return output;
    }
  }

  if (part.state.status === "error") {
    return part.state.error.trim() || undefined;
  }

  const command =
    part.state.input && typeof part.state.input === "object" && "command" in part.state.input
      ? part.state.input.command
      : undefined;
  if (typeof command === "string" && command.trim().length > 0) {
    return command.trim();
  }

  return part.tool;
}

function summarizePermissionDetail(patterns: ReadonlyArray<string>): string | undefined {
  if (patterns.length === 0) {
    return undefined;
  }
  return patterns.join(", ");
}

function isAbortSessionError(error: unknown): boolean {
  if (!error || typeof error !== "object" || Array.isArray(error)) {
    return false;
  }
  const record = error as { name?: unknown };
  return record.name === "MessageAbortedError";
}

function setState(state: OpenCodeSessionState, updates: Partial<OpenCodeSessionState>): void {
  Object.assign(state, updates, { updatedAt: nowIso() });
}

function markObservedTurnActivity(state: OpenCodeSessionState, turnId: TurnId | undefined): void {
  if (!turnId) {
    return;
  }
  const turnKey = String(turnId);
  state.observedTurnActivity.set(turnKey, (state.observedTurnActivity.get(turnKey) ?? 0) + 1);
}

async function loadMessages(state: OpenCodeSessionState) {
  return state.lease.client.session
    .messages({ sessionID: state.sessionId }, SDK_OPTIONS)
    .then((result) => result.data);
}

async function loadAssistantDetail(
  state: OpenCodeSessionState,
  messageId: string,
): Promise<string | undefined> {
  const message = await state.lease.client.session.message(
    { sessionID: state.sessionId, messageID: messageId },
    SDK_OPTIONS,
  );
  return assistantTextFromParts(message.data.parts);
}

async function loadSessionHistorySummary(state: OpenCodeSessionState): Promise<{
  orderedUserMessageIds: Array<string>;
  recoveredAbortedTurnId: TurnId | undefined;
  lastCompletedTurnId: TurnId | undefined;
}> {
  const messages = await loadMessages(state);
  const orderedUserMessageIds = messages
    .filter((entry) => entry.info.role === "user")
    .map((entry) => entry.info.id);

  const latestAssistantByParentId = new Map<string, AssistantMessage>();
  for (const entry of messages) {
    if (entry.info.role === "assistant") {
      latestAssistantByParentId.set(entry.info.parentID, entry.info);
    }
  }

  const lastCompletedUserMessageId = [...orderedUserMessageIds].toReversed().find((messageId) => {
    const assistant = latestAssistantByParentId.get(messageId);
    return assistant !== undefined && isTerminalAssistantMessage(assistant);
  });
  const recoveredAbortedUserMessageId = [...orderedUserMessageIds]
    .toReversed()
    .find((messageId) => {
      const assistant = latestAssistantByParentId.get(messageId);
      return assistant === undefined || !isTerminalAssistantMessage(assistant);
    });

  return {
    orderedUserMessageIds,
    recoveredAbortedTurnId: recoveredAbortedUserMessageId
      ? toTurnIdForUserMessage(recoveredAbortedUserMessageId)
      : undefined,
    lastCompletedTurnId: lastCompletedUserMessageId
      ? toTurnIdForUserMessage(lastCompletedUserMessageId)
      : undefined,
  };
}

async function loadTerminalAssistantForTurn(
  state: OpenCodeSessionState,
  turnId: TurnId,
): Promise<AssistantMessage | undefined> {
  const userMessageId = userMessageIdFromTurnId(turnId);
  if (!userMessageId) {
    return undefined;
  }

  const messages = await loadMessages(state);
  return messages
    .flatMap((entry) =>
      entry.info.role === "assistant" && entry.info.parentID === userMessageId ? [entry.info] : [],
    )
    .toReversed()
    .find(isTerminalAssistantMessage);
}

async function waitForTerminalAssistantForTurn(
  state: OpenCodeSessionState,
  turnId: TurnId,
): Promise<AssistantMessage | undefined> {
  for (let attempt = 0; attempt < IDLE_COMPLETION_POLL_ATTEMPTS; attempt += 1) {
    const assistant = await loadTerminalAssistantForTurn(state, turnId).catch(() => undefined);
    if (assistant) {
      return assistant;
    }
    if (attempt < IDLE_COMPLETION_POLL_ATTEMPTS - 1) {
      await new Promise((resolve) => setTimeout(resolve, IDLE_COMPLETION_POLL_INTERVAL_MS));
    }
  }
  return undefined;
}

const makeOpenCodeAdapter = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const serverConfig = yield* ServerConfig;
  const serverSettingsService = yield* ServerSettingsService;
  const pool = yield* OpenCodeServerPool;
  const services = yield* Effect.services<never>();
  const runPromise = Effect.runPromiseWith(services);
  const runtimeEventQueue = yield* Queue.unbounded<ProviderRuntimeEvent>();

  const sessions = new Map<ThreadId, OpenCodeSessionState>();
  const threadIdBySessionId = new Map<string, ThreadId>();
  const watchers = new Map<string, SidecarWatcher>();

  const publishRuntimeEvents = (events: ReadonlyArray<ProviderRuntimeEvent>) =>
    Queue.offerAll(runtimeEventQueue, events).pipe(Effect.asVoid);

  const runtimeEventBase = (input: {
    readonly threadId: ThreadId;
    readonly createdAt?: string | undefined;
    readonly turnId?: TurnId | undefined;
    readonly itemId?: RuntimeItemId | undefined;
    readonly requestId?: RuntimeRequestId | undefined;
  }) => ({
    eventId: EventId.makeUnsafe(randomUUID()),
    provider: PROVIDER,
    threadId: input.threadId,
    createdAt: input.createdAt ?? nowIso(),
    ...(input.turnId ? { turnId: input.turnId } : {}),
    ...(input.itemId ? { itemId: input.itemId } : {}),
    ...(input.requestId ? { requestId: input.requestId } : {}),
  });

  const hydrateRecoveredPendingRequests = async (
    state: OpenCodeSessionState,
  ): Promise<Array<ProviderRuntimeEvent>> => {
    const createdAt = nowIso();
    const runtimeEvents: Array<ProviderRuntimeEvent> = [];

    const permissionRequests = await state.lease.client.permission
      .list({}, SDK_OPTIONS)
      .then((result) => result.data as Array<PermissionRequest>);
    for (const permissionRequest of permissionRequests) {
      if (permissionRequest.sessionID !== state.sessionId) {
        continue;
      }
      if (state.pendingRequests.has(permissionRequest.id)) {
        continue;
      }

      const toolName = permissionRequest.tool
        ? state.knownToolsByCallId.get(permissionRequest.tool.callID)?.toolName
        : undefined;
      const requestType = requestTypeForPermissionRequest(permissionRequest, toolName);
      const turnId =
        toTurnIdForOpenCodeMessage(permissionRequest.tool?.messageID) ?? state.activeTurnId;
      const itemId = permissionRequest.tool
        ? toToolItemId(permissionRequest.tool.callID)
        : undefined;
      state.pendingRequests.set(permissionRequest.id, {
        kind: "permission",
        requestType,
        turnId,
        itemId,
      });
      runtimeEvents.push({
        ...runtimeEventBase({
          threadId: state.threadId,
          createdAt,
          turnId,
          itemId,
          requestId: RuntimeRequestId.makeUnsafe(permissionRequest.id),
        }),
        type: "request.opened",
        payload: {
          requestType,
          ...(summarizePermissionDetail(permissionRequest.patterns)
            ? { detail: summarizePermissionDetail(permissionRequest.patterns) }
            : {}),
          args: permissionRequest,
        },
      });
    }

    const questionRequests = await state.lease.client.question
      .list({}, SDK_OPTIONS)
      .then((result) => result.data as Array<QuestionRequest>);
    for (const questionRequest of questionRequests) {
      if (questionRequest.sessionID !== state.sessionId) {
        continue;
      }
      if (state.pendingRequests.has(questionRequest.id)) {
        continue;
      }

      const mappedQuestions = mapOpenCodeQuestions(questionRequest.questions);
      const turnId =
        toTurnIdForOpenCodeMessage(questionRequest.tool?.messageID) ?? state.activeTurnId;
      const itemId = questionRequest.tool ? toToolItemId(questionRequest.tool.callID) : undefined;
      state.pendingRequests.set(
        questionRequest.id,
        toPendingQuestionRequest({
          turnId,
          itemId,
          questions: mappedQuestions,
        }),
      );
      runtimeEvents.push({
        ...runtimeEventBase({
          threadId: state.threadId,
          createdAt,
          turnId,
          itemId,
          requestId: RuntimeRequestId.makeUnsafe(questionRequest.id),
        }),
        type: "user-input.requested",
        payload: {
          questions: toRuntimeQuestionPayload(mappedQuestions),
        },
      });
    }

    return runtimeEvents;
  };

  const recoverPendingQuestionRequest = async (
    state: OpenCodeSessionState,
    requestId: ApprovalRequestId,
  ): Promise<PendingQuestionRequest | undefined> => {
    const existing = state.pendingRequests.get(requestId);
    if (existing?.kind === "question") {
      return existing;
    }

    const questionRequests = await state.lease.client.question
      .list({}, SDK_OPTIONS)
      .then((result) => result.data as Array<QuestionRequest>);
    const match = questionRequests.find(
      (request) => request.id === requestId && request.sessionID === state.sessionId,
    );
    if (!match) {
      return undefined;
    }

    const mappedQuestions = mapOpenCodeQuestions(match.questions);
    const recovered = toPendingQuestionRequest({
      turnId: toTurnIdForOpenCodeMessage(match.tool?.messageID) ?? state.activeTurnId,
      itemId: match.tool ? toToolItemId(match.tool.callID) : undefined,
      questions: mappedQuestions,
    });
    state.pendingRequests.set(requestId, recovered);
    return recovered;
  };

  const publishAssistantCompletion = async (
    state: OpenCodeSessionState,
    assistant: AssistantMessage,
  ): Promise<void> => {
    const turnId = toTurnIdForUserMessage(assistant.parentID);
    markObservedTurnActivity(state, turnId);
    if (state.terminalTurnIds.has(String(turnId))) {
      return;
    }

    state.terminalTurnIds.add(String(turnId));
    const assistantText = await loadAssistantDetail(state, assistant.id).catch(() => undefined);
    setState(state, {
      activeTurnId:
        state.activeTurnId && String(state.activeTurnId) === String(turnId)
          ? undefined
          : state.activeTurnId,
      abortErrorSuppressionUntil: undefined,
      lastCompletedTurnId: turnId,
      model: `${assistant.providerID}/${assistant.modelID}`,
      status: assistant.error ? "error" : "ready",
      lastError: toOpenCodeErrorMessage(assistant.error),
    });

    const createdAt = nowIso();
    const runtimeEvents: Array<ProviderRuntimeEvent> = [
      {
        ...runtimeEventBase({
          threadId: state.threadId,
          createdAt,
          turnId,
        }),
        type: "item.completed",
        payload: {
          itemType: "assistant_message",
          status: assistant.error ? "failed" : "completed",
          title: "Assistant message",
          ...(assistantText ? { detail: assistantText } : {}),
          data: assistant,
        },
      },
      {
        ...runtimeEventBase({
          threadId: state.threadId,
          createdAt,
          turnId,
        }),
        type: "turn.completed",
        payload: {
          state: toRuntimeTurnState(assistant),
          ...(assistant.finish ? { stopReason: assistant.finish } : {}),
          usage: assistant.tokens,
          modelUsage: {
            [assistant.providerID]: assistant.tokens,
          },
          totalCostUsd: assistant.cost,
          ...(toOpenCodeErrorMessage(assistant.error)
            ? { errorMessage: toOpenCodeErrorMessage(assistant.error) }
            : {}),
        },
      },
    ];

    if (assistantText && isPlanAgent(assistant.agent)) {
      runtimeEvents.push({
        ...runtimeEventBase({
          threadId: state.threadId,
          createdAt,
          turnId,
        }),
        type: "turn.proposed.completed",
        payload: {
          planMarkdown: assistantText,
        },
      });
    }

    await runPromise(publishRuntimeEvents(runtimeEvents));
  };

  const scheduleIdleTurnCheck = (state: OpenCodeSessionState, turnId: TurnId) => {
    const turnKey = String(turnId);
    const observedActivityVersion = state.observedTurnActivity.get(turnKey) ?? 0;
    const idleCheckKey = `${turnKey}:${observedActivityVersion}`;
    if (state.pendingIdleTurnChecks.has(idleCheckKey)) {
      return;
    }

    state.pendingIdleTurnChecks.add(idleCheckKey);
    void (async () => {
      try {
        const assistant = await waitForTerminalAssistantForTurn(state, turnId);
        if (assistant) {
          await publishAssistantCompletion(state, assistant);
          return;
        }

        if (
          state.terminalTurnIds.has(turnKey) ||
          (state.observedTurnActivity.get(turnKey) ?? 0) !== observedActivityVersion ||
          String(state.activeTurnId) !== turnKey
        ) {
          return;
        }

        state.terminalTurnIds.add(turnKey);
        setState(state, { activeTurnId: undefined, status: "ready" });
        await runPromise(
          publishRuntimeEvents([
            {
              ...runtimeEventBase({
                threadId: state.threadId,
                createdAt: nowIso(),
                turnId,
              }),
              type: "turn.aborted",
              payload: {
                reason: "OpenCode session became idle before completing the active turn.",
              },
            },
          ]),
        );
      } catch {
        // The watcher must keep processing later SSE events even if idle
        // reconciliation fails.
      } finally {
        state.pendingIdleTurnChecks.delete(idleCheckKey);
      }
    })();
  };

  const activeSessionsForKey = (key: string) =>
    Array.from(sessions.values()).filter((session) => session.lease.key === key);

  const stopWatcherIfUnused = (key: string) =>
    Effect.sync(() => {
      if (activeSessionsForKey(key).length > 0) {
        return;
      }
      const watcher = watchers.get(key);
      if (!watcher) {
        return;
      }
      watcher.abortController.abort();
      watchers.delete(key);
    });

  const getStateByThreadId = (threadId: ThreadId) => sessions.get(threadId);
  const getStateBySessionId = (sessionId: string) => {
    const threadId = threadIdBySessionId.get(sessionId);
    return threadId ? sessions.get(threadId) : undefined;
  };

  const ensureWatcher = (state: OpenCodeSessionState) =>
    Effect.tryPromise({
      try: async () => {
        const existing = watchers.get(state.lease.key);
        if (existing) {
          await existing.ready;
          return;
        }

        const abortController = new AbortController();
        const ready = Promise.withResolvers<void>();
        const task = (async () => {
          try {
            const subscription = await state.lease.client.event.subscribe(undefined, {
              ...SDK_OPTIONS,
              signal: abortController.signal,
            });
            ready.resolve();

            for await (const event of subscription.stream) {
              if (abortController.signal.aborted) {
                break;
              }

              const sessionState = resolveSessionForEvent(event, getStateBySessionId);
              if (!sessionState) {
                continue;
              }

              await handleEvent(sessionState, event);
            }
          } catch (error) {
            ready.reject(error);
            // The SDK SSE client retries internally; ignored here.
          } finally {
            watchers.delete(state.lease.key);
          }
        })();

        watchers.set(state.lease.key, {
          key: state.lease.key,
          abortController,
          task,
          ready: ready.promise,
        });

        await ready.promise;
      },
      catch: (cause) =>
        toWatcherRequestError(
          state.threadId,
          cause instanceof Error ? cause.message : "Failed to establish the OpenCode event stream.",
          cause,
        ),
    });

  const handleEvent = async (sessionState: OpenCodeSessionState, event: Event) => {
    switch (event.type) {
      case "session.status": {
        if (event.properties.status.type === "retry") {
          const createdAt = nowIso();
          setState(sessionState, { status: "running" });
          markObservedTurnActivity(sessionState, sessionState.activeTurnId);
          await runPromise(
            publishRuntimeEvents([
              {
                ...runtimeEventBase({
                  threadId: sessionState.threadId,
                  createdAt,
                }),
                type: "session.state.changed",
                payload: {
                  state: "waiting",
                  reason: event.properties.status.message,
                  detail: event.properties.status,
                },
              },
            ]),
          );
          break;
        }

        if (event.properties.status.type === "busy") {
          setState(sessionState, { status: "running" });
          markObservedTurnActivity(sessionState, sessionState.activeTurnId);
          break;
        }

        if (
          sessionState.activeTurnId &&
          !sessionState.terminalTurnIds.has(String(sessionState.activeTurnId))
        ) {
          scheduleIdleTurnCheck(sessionState, sessionState.activeTurnId);
        } else {
          setState(sessionState, { status: "ready" });
        }
        break;
      }

      case "message.part.updated": {
        const part = event.properties.part;
        sessionState.knownPartKinds.set(part.id, part.type);

        if (part.type !== "tool") {
          break;
        }

        const itemId = toToolItemId(part.callID);
        const turnId = sessionState.activeTurnId ?? sessionState.lastCompletedTurnId;
        markObservedTurnActivity(sessionState, turnId);
        const previousStatus = sessionState.knownToolStatuses.get(part.id);
        const itemType = toCanonicalToolItemType(part.tool);
        const detail = summarizeToolDetail(part);
        sessionState.knownToolStatuses.set(part.id, part.state.status);
        sessionState.knownToolsByCallId.set(part.callID, {
          partId: part.id,
          toolName: part.tool,
        });

        const createdAt = nowIso();
        if (!previousStatus) {
          await runPromise(
            publishRuntimeEvents([
              {
                ...runtimeEventBase({
                  threadId: sessionState.threadId,
                  createdAt,
                  turnId,
                  itemId,
                }),
                type: "item.started",
                payload: {
                  itemType,
                  status: "inProgress",
                  title: part.tool,
                  ...(detail ? { detail } : {}),
                  data: part,
                },
              },
            ]),
          );
          break;
        }

        if (part.state.status === "completed" || part.state.status === "error") {
          await runPromise(
            publishRuntimeEvents([
              {
                ...runtimeEventBase({
                  threadId: sessionState.threadId,
                  createdAt,
                  turnId,
                  itemId,
                }),
                type: "item.completed",
                payload: {
                  itemType,
                  status: part.state.status === "completed" ? "completed" : "failed",
                  title: part.state.status === "completed" ? part.state.title : part.tool,
                  ...(detail ? { detail } : {}),
                  data: part,
                },
              },
            ]),
          );
          break;
        }

        await runPromise(
          publishRuntimeEvents([
            {
              ...runtimeEventBase({
                threadId: sessionState.threadId,
                createdAt,
                turnId,
                itemId,
              }),
              type: "item.updated",
              payload: {
                itemType,
                status: "inProgress",
                title: part.tool,
                ...(detail ? { detail } : {}),
                data: part,
              },
            },
          ]),
        );
        break;
      }

      case "message.part.delta": {
        if (event.properties.field !== "text") {
          break;
        }

        const partKind = sessionState.knownPartKinds.get(event.properties.partID);
        const turnId = sessionState.activeTurnId;
        if (!turnId) {
          break;
        }
        markObservedTurnActivity(sessionState, turnId);

        await runPromise(
          publishRuntimeEvents([
            {
              ...runtimeEventBase({
                threadId: sessionState.threadId,
                createdAt: nowIso(),
                turnId,
              }),
              type: "content.delta",
              payload: {
                streamKind: partKind === "reasoning" ? "reasoning_text" : "assistant_text",
                delta: event.properties.delta,
              },
            },
          ]),
        );
        break;
      }

      case "message.updated": {
        if (event.properties.info.role !== "assistant") {
          break;
        }

        const assistant = event.properties.info;
        if (!isTerminalAssistantMessage(assistant)) {
          break;
        }
        await publishAssistantCompletion(sessionState, assistant);
        break;
      }

      case "permission.asked": {
        const toolName = event.properties.tool
          ? sessionState.knownToolsByCallId.get(event.properties.tool.callID)?.toolName
          : undefined;
        const requestType = requestTypeForPermissionRequest(event.properties, toolName);
        const turnId = sessionState.activeTurnId;
        markObservedTurnActivity(sessionState, turnId);
        const itemId = event.properties.tool
          ? toToolItemId(event.properties.tool.callID)
          : undefined;
        sessionState.pendingRequests.set(event.properties.id, {
          kind: "permission",
          requestType,
          turnId,
          itemId,
        });

        await runPromise(
          publishRuntimeEvents([
            {
              ...runtimeEventBase({
                threadId: sessionState.threadId,
                createdAt: nowIso(),
                turnId,
                itemId,
                requestId: RuntimeRequestId.makeUnsafe(event.properties.id),
              }),
              type: "request.opened",
              payload: {
                requestType,
                ...(summarizePermissionDetail(event.properties.patterns)
                  ? { detail: summarizePermissionDetail(event.properties.patterns) }
                  : {}),
                args: event.properties,
              },
            },
          ]),
        );
        break;
      }

      case "permission.replied": {
        const pending = sessionState.pendingRequests.get(event.properties.requestID);
        if (!pending || pending.kind !== "permission") {
          break;
        }
        sessionState.pendingRequests.delete(event.properties.requestID);
        await runPromise(
          publishRuntimeEvents([
            {
              ...runtimeEventBase({
                threadId: sessionState.threadId,
                createdAt: nowIso(),
                turnId: pending.turnId,
                itemId: pending.itemId,
                requestId: RuntimeRequestId.makeUnsafe(event.properties.requestID),
              }),
              type: "request.resolved",
              payload: {
                requestType: pending.requestType,
                resolution: event.properties,
              },
            },
          ]),
        );
        break;
      }

      case "question.asked": {
        const turnId = sessionState.activeTurnId;
        markObservedTurnActivity(sessionState, turnId);
        const itemId = event.properties.tool
          ? toToolItemId(event.properties.tool.callID)
          : undefined;
        const mappedQuestions = mapOpenCodeQuestions(event.properties.questions);
        sessionState.pendingRequests.set(
          event.properties.id,
          toPendingQuestionRequest({
            turnId,
            itemId,
            questions: mappedQuestions,
          }),
        );

        await runPromise(
          publishRuntimeEvents([
            {
              ...runtimeEventBase({
                threadId: sessionState.threadId,
                createdAt: nowIso(),
                turnId,
                itemId,
                requestId: RuntimeRequestId.makeUnsafe(event.properties.id),
              }),
              type: "user-input.requested",
              payload: {
                questions: toRuntimeQuestionPayload(mappedQuestions),
              },
            },
          ]),
        );
        break;
      }

      case "question.replied": {
        const pending = sessionState.pendingRequests.get(event.properties.requestID);
        if (!pending || pending.kind !== "question") {
          break;
        }
        sessionState.pendingRequests.delete(event.properties.requestID);
        await runPromise(
          publishRuntimeEvents([
            {
              ...runtimeEventBase({
                threadId: sessionState.threadId,
                createdAt: nowIso(),
                turnId: pending.turnId,
                itemId: pending.itemId,
                requestId: RuntimeRequestId.makeUnsafe(event.properties.requestID),
              }),
              type: "user-input.resolved",
              payload: {
                answers: toUserInputAnswerRecord(pending, event.properties.answers),
              },
            },
          ]),
        );
        break;
      }

      case "question.rejected": {
        const pending = sessionState.pendingRequests.get(event.properties.requestID);
        if (!pending || pending.kind !== "question") {
          break;
        }
        sessionState.pendingRequests.delete(event.properties.requestID);
        await runPromise(
          publishRuntimeEvents([
            {
              ...runtimeEventBase({
                threadId: sessionState.threadId,
                createdAt: nowIso(),
                turnId: pending.turnId,
                itemId: pending.itemId,
                requestId: RuntimeRequestId.makeUnsafe(event.properties.requestID),
              }),
              type: "user-input.resolved",
              payload: {
                answers: {},
              },
            },
          ]),
        );
        break;
      }

      case "todo.updated": {
        const turnId = sessionState.activeTurnId ?? sessionState.lastCompletedTurnId;
        if (!turnId) {
          break;
        }
        markObservedTurnActivity(sessionState, turnId);
        await runPromise(
          publishRuntimeEvents([
            {
              ...runtimeEventBase({
                threadId: sessionState.threadId,
                createdAt: nowIso(),
                turnId,
              }),
              type: "turn.plan.updated",
              payload: {
                plan: event.properties.todos.map((todo) => ({
                  step: todo.content,
                  status: toRuntimePlanStepStatus(todo.status),
                })),
              },
            },
          ]),
        );
        break;
      }

      case "session.diff": {
        const turnId = sessionState.lastCompletedTurnId ?? sessionState.activeTurnId;
        if (!turnId || event.properties.diff.length === 0) {
          break;
        }
        markObservedTurnActivity(sessionState, turnId);
        await runPromise(
          publishRuntimeEvents([
            {
              ...runtimeEventBase({
                threadId: sessionState.threadId,
                createdAt: nowIso(),
                turnId,
              }),
              type: "turn.diff.updated",
              payload: {
                unifiedDiff: buildOpenCodeDiffSummary(event.properties.diff),
              },
            },
          ]),
        );
        break;
      }

      case "session.error": {
        if (
          isAbortSessionError(event.properties.error) &&
          sessionState.abortErrorSuppressionUntil !== undefined &&
          Date.now() <= sessionState.abortErrorSuppressionUntil
        ) {
          setState(sessionState, { abortErrorSuppressionUntil: undefined });
          break;
        }

        const message = event.properties.error
          ? toOpenCodeErrorMessage(event.properties.error)
          : undefined;
        if (!message) {
          break;
        }
        setState(sessionState, {
          abortErrorSuppressionUntil: undefined,
          status: "error",
          lastError: message,
        });
        await runPromise(
          publishRuntimeEvents([
            {
              ...runtimeEventBase({
                threadId: sessionState.threadId,
                createdAt: nowIso(),
                turnId: sessionState.activeTurnId,
              }),
              type: "runtime.error",
              payload: {
                message,
                class: "provider_error",
                detail: event.properties,
              },
            },
          ]),
        );
        break;
      }

      default:
        break;
    }
  };

  yield* Effect.forkScoped(
    Stream.runForEach(pool.streamEvents, (event) =>
      Effect.gen(function* () {
        if (event.expected) {
          return;
        }

        const affected = activeSessionsForKey(event.key);
        for (const state of affected) {
          sessions.delete(state.threadId);
          threadIdBySessionId.delete(state.sessionId);
        }
        yield* stopWatcherIfUnused(event.key);

        const runtimeEvents = affected.flatMap((state) => {
          const events: Array<ProviderRuntimeEvent> = [];
          if (state.activeTurnId && !state.terminalTurnIds.has(String(state.activeTurnId))) {
            state.terminalTurnIds.add(String(state.activeTurnId));
            events.push({
              ...runtimeEventBase({
                threadId: state.threadId,
                createdAt: nowIso(),
                turnId: state.activeTurnId,
              }),
              type: "turn.aborted",
              payload: {
                reason: "OpenCode sidecar exited unexpectedly.",
              },
            });
          }

          events.push(
            {
              ...runtimeEventBase({
                threadId: state.threadId,
                createdAt: nowIso(),
              }),
              type: "session.exited",
              payload: {
                reason: event.detail ?? "OpenCode sidecar exited unexpectedly.",
                recoverable: true,
                exitKind: "error",
              },
            },
            {
              ...runtimeEventBase({
                threadId: state.threadId,
                createdAt: nowIso(),
              }),
              type: "runtime.error",
              payload: {
                message: event.detail ?? "OpenCode sidecar exited unexpectedly.",
                class: "transport_error",
              },
            },
          );

          return events;
        });

        if (runtimeEvents.length > 0) {
          yield* publishRuntimeEvents(runtimeEvents);
        }
      }),
    ),
  );

  const startSession: OpenCodeAdapterShape["startSession"] = (input) =>
    Effect.gen(function* () {
      if (input.provider !== undefined && input.provider !== PROVIDER) {
        return yield* new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "startSession",
          issue: `Expected provider '${PROVIDER}' but received '${input.provider}'.`,
        });
      }

      const existing = getStateByThreadId(input.threadId);
      if (existing) {
        yield* existing.lease.release;
        sessions.delete(existing.threadId);
        threadIdBySessionId.delete(existing.sessionId);
        yield* stopWatcherIfUnused(existing.lease.key);
      }

      const cwd = input.cwd ?? process.cwd();
      const poolRoot = input.poolRoot ?? cwd;
      const binaryPath =
        input.providerOptions?.opencode?.binaryPath ??
        (yield* serverSettingsService.getSettings.pipe(
          Effect.map((settings) => settings.providers.opencode.binaryPath),
          Effect.mapError(
            (error) =>
              new ProviderAdapterProcessError({
                provider: PROVIDER,
                threadId: input.threadId,
                detail: error.message,
                cause: error,
              }),
          ),
        ));
      const lease = yield* pool.acquire(
        binaryPath ? { cwd, poolRoot, binaryPath } : { cwd, poolRoot },
      );

      const sessionIdFromResumeCursor = readSessionIdFromResumeCursor(input.resumeCursor);
      const { sessionInfo, resumedExistingSession } = yield* Effect.tryPromise({
        try: async () => {
          if (sessionIdFromResumeCursor) {
            try {
              const recoveredSession = await lease.client.session
                .get({ sessionID: sessionIdFromResumeCursor }, SDK_OPTIONS)
                .then((result) => result.data as Session);
              return {
                sessionInfo: recoveredSession,
                resumedExistingSession: true as const,
              };
            } catch {
              // Fall through to fresh session creation.
            }
          }

          const freshSession = await lease.client.session
            .create(
              {
                title: `T3 ${input.threadId}`,
                permission: buildOpenCodePermissionRules(input.runtimeMode),
              },
              SDK_OPTIONS,
            )
            .then((result) => result.data as Session);
          return {
            sessionInfo: freshSession,
            resumedExistingSession: false as const,
          };
        },
        catch: (cause) =>
          new ProviderAdapterProcessError({
            provider: PROVIDER,
            threadId: input.threadId,
            detail: cause instanceof Error ? cause.message : "Failed to start OpenCode session.",
            ...(cause !== undefined ? { cause } : {}),
          }),
      });

      const resolvedRuntimeMode =
        runtimeModeFromOpenCodePermissionRules(sessionInfo.permission) ?? input.runtimeMode;
      const selectedModel =
        input.modelSelection?.provider === PROVIDER ? input.modelSelection.model : undefined;

      const state: OpenCodeSessionState = {
        threadId: input.threadId,
        createdAt: nowIso(),
        lease,
        sessionId: sessionInfo.id,
        cwd,
        poolRoot,
        ...(binaryPath ? { binaryPath } : {}),
        runtimeMode: resolvedRuntimeMode,
        model: selectedModel,
        status: "ready",
        updatedAt: nowIso(),
        lastError: undefined,
        activeTurnId: undefined,
        lastCompletedTurnId: undefined,
        terminalTurnIds: new Set(),
        knownPartKinds: new Map(),
        knownToolStatuses: new Map(),
        knownToolsByCallId: new Map(),
        pendingRequests: new Map(),
        orderedUserMessageIds: [],
        abortErrorSuppressionUntil: undefined,
        observedTurnActivity: new Map(),
        pendingIdleTurnChecks: new Set(),
      };

      const history = yield* Effect.tryPromise({
        try: () => loadSessionHistorySummary(state),
        catch: (cause) =>
          toRequestError(
            "session.messages",
            cause instanceof Error ? cause.message : "Failed to inspect OpenCode session history.",
            cause,
          ),
      });
      state.orderedUserMessageIds = history.orderedUserMessageIds;
      state.lastCompletedTurnId = history.lastCompletedTurnId;

      const recoveredPendingRuntimeEvents = resumedExistingSession
        ? yield* Effect.tryPromise({
            try: () => hydrateRecoveredPendingRequests(state),
            catch: (cause) =>
              toRequestError(
                "session.pending.requests",
                cause instanceof Error
                  ? cause.message
                  : "Failed to hydrate pending OpenCode interactive requests.",
                cause,
              ),
          }).pipe(
            Effect.catch((error) =>
              Effect.succeed<Array<ProviderRuntimeEvent>>([
                {
                  ...runtimeEventBase({
                    threadId: state.threadId,
                    createdAt: nowIso(),
                  }),
                  type: "runtime.warning",
                  payload: {
                    message:
                      "Recovered OpenCode session but could not hydrate pending interactive requests.",
                    detail: error.detail,
                  },
                },
              ]),
            ),
          )
        : [];

      sessions.set(input.threadId, state);
      threadIdBySessionId.set(state.sessionId, input.threadId);
      yield* ensureWatcher(state).pipe(
        Effect.catch((error) =>
          state.lease.release.pipe(
            Effect.flatMap(() => {
              sessions.delete(input.threadId);
              threadIdBySessionId.delete(state.sessionId);
              return stopWatcherIfUnused(state.lease.key);
            }),
            Effect.flatMap(() => Effect.fail(error)),
          ),
        ),
      );

      const runtimeEvents: Array<ProviderRuntimeEvent> = [
        {
          ...runtimeEventBase({ threadId: state.threadId, createdAt: state.updatedAt }),
          type: "session.started",
          payload: {
            message: resumedExistingSession
              ? "Recovered OpenCode session."
              : "Started OpenCode session.",
            resume: {
              sessionId: state.sessionId,
            },
          },
        },
        {
          ...runtimeEventBase({ threadId: state.threadId, createdAt: state.updatedAt }),
          type: "thread.started",
          payload: {
            providerThreadId: state.sessionId,
          },
        },
        {
          ...runtimeEventBase({ threadId: state.threadId, createdAt: state.updatedAt }),
          type: "session.state.changed",
          payload: {
            state: "ready",
          },
        },
      ];

      if (history.recoveredAbortedTurnId) {
        state.terminalTurnIds.add(String(history.recoveredAbortedTurnId));
        runtimeEvents.push({
          ...runtimeEventBase({
            threadId: state.threadId,
            createdAt: state.updatedAt,
            turnId: history.recoveredAbortedTurnId,
          }),
          type: "turn.aborted",
          payload: {
            reason:
              "Recovered OpenCode session after sidecar loss; the in-flight turn cannot be resumed.",
          },
        });
      }

      runtimeEvents.push(...recoveredPendingRuntimeEvents);

      yield* publishRuntimeEvents(runtimeEvents);
      return toProviderSessionSnapshot(state);
    });

  const sendTurn: OpenCodeAdapterShape["sendTurn"] = (input) =>
    Effect.gen(function* () {
      const state = getStateByThreadId(input.threadId);
      if (!state) {
        return yield* missingSession(input.threadId);
      }

      const parts: Array<
        | {
            readonly type: "text";
            readonly text: string;
          }
        | {
            readonly type: "file";
            readonly mime: string;
            readonly filename: string;
            readonly url: string;
          }
      > = [];
      if (input.input) {
        parts.push({ type: "text", text: input.input });
      }

      const attachments = yield* Effect.forEach(
        input.attachments ?? [],
        (attachment) =>
          Effect.gen(function* () {
            const attachmentPath = resolveAttachmentPath({
              attachmentsDir: serverConfig.attachmentsDir,
              attachment,
            });
            if (!attachmentPath) {
              return yield* new ProviderAdapterRequestError({
                provider: PROVIDER,
                method: "session.promptAsync",
                detail: `Invalid attachment id '${attachment.id}'.`,
              });
            }

            const bytes = yield* fileSystem
              .readFile(attachmentPath)
              .pipe(
                Effect.mapError((cause) =>
                  toRequestError(
                    "session.promptAsync",
                    cause instanceof Error ? cause.message : "Failed to read attachment file.",
                    cause,
                  ),
                ),
              );
            return {
              type: "file" as const,
              mime: attachment.mimeType,
              filename: attachment.name,
              url: `data:${attachment.mimeType};base64,${Buffer.from(bytes).toString("base64")}`,
            };
          }),
        { concurrency: 1 },
      );
      parts.push(...attachments);

      if (parts.length === 0) {
        return yield* new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "sendTurn",
          issue: "Turn input must include text or attachments.",
        });
      }

      const openCodeMessageId = `msg_${randomUUID()}`;
      const turnId = toTurnIdForUserMessage(openCodeMessageId);
      const selectedModel =
        input.modelSelection?.provider === PROVIDER
          ? toOpenCodeModel(input.modelSelection.model)
          : undefined;
      const selectedModelSlug =
        input.modelSelection?.provider === PROVIDER ? input.modelSelection.model : undefined;
      const agent =
        input.interactionMode === undefined || input.interactionMode === "default"
          ? "build"
          : input.interactionMode;

      state.orderedUserMessageIds.push(openCodeMessageId);
      setState(state, {
        activeTurnId: turnId,
        abortErrorSuppressionUntil: undefined,
        status: "running",
        model: selectedModelSlug ?? state.model,
        lastError: undefined,
      });
      state.observedTurnActivity.delete(String(turnId));

      yield* publishRuntimeEvents([
        {
          ...runtimeEventBase({
            threadId: state.threadId,
            createdAt: state.updatedAt,
            turnId,
          }),
          type: "turn.started",
          payload: selectedModelSlug ? { model: selectedModelSlug } : {},
        },
      ]);

      const promptRequest = state.lease.client.session.promptAsync(
        {
          sessionID: state.sessionId,
          messageID: openCodeMessageId,
          ...(selectedModel ? { model: selectedModel } : {}),
          agent,
          parts,
        },
        SDK_OPTIONS,
      );

      const startupRejected = yield* Effect.promise(() =>
        Promise.race([
          promptRequest.then(
            () => false,
            () => true,
          ),
          Promise.resolve().then(() => false),
        ]),
      );

      if (startupRejected) {
        const failure = yield* Effect.promise(() =>
          promptRequest.then(
            () =>
              toRequestError(
                "session.promptAsync",
                "OpenCode prompt unexpectedly resolved after the startup rejection probe.",
              ),
            (cause) =>
              toRequestError(
                "session.promptAsync",
                cause instanceof Error ? cause.message : "Failed to start OpenCode turn.",
                cause,
              ),
          ),
        );

        state.terminalTurnIds.add(String(turnId));
        setState(state, {
          activeTurnId: undefined,
          status: "error",
          lastError: failure.detail,
        });

        yield* publishRuntimeEvents([
          {
            ...runtimeEventBase({
              threadId: state.threadId,
              createdAt: nowIso(),
              turnId,
            }),
            type: "runtime.error",
            payload: {
              message: failure.detail,
              class: "provider_error",
              detail: failure.cause ?? failure,
            },
          },
          {
            ...runtimeEventBase({
              threadId: state.threadId,
              createdAt: nowIso(),
              turnId,
            }),
            type: "turn.completed",
            payload: {
              state: "failed",
              errorMessage: failure.detail,
            },
          },
        ]);
        return yield* failure;
      }

      void promptRequest.catch((cause) => {
        if (
          state.terminalTurnIds.has(String(turnId)) ||
          (state.observedTurnActivity.get(String(turnId)) ?? 0) > 0
        ) {
          return;
        }

        state.terminalTurnIds.add(String(turnId));
        setState(state, {
          activeTurnId:
            state.activeTurnId && String(state.activeTurnId) === String(turnId)
              ? undefined
              : state.activeTurnId,
          status: "error",
          lastError: cause instanceof Error ? cause.message : "Failed to start OpenCode turn.",
        });

        const message = cause instanceof Error ? cause.message : "Failed to start OpenCode turn.";
        void runPromise(
          publishRuntimeEvents([
            {
              ...runtimeEventBase({
                threadId: state.threadId,
                createdAt: nowIso(),
                turnId,
              }),
              type: "runtime.error",
              payload: {
                message,
                class: "provider_error",
                detail: cause,
              },
            },
            {
              ...runtimeEventBase({
                threadId: state.threadId,
                createdAt: nowIso(),
                turnId,
              }),
              type: "turn.completed",
              payload: {
                state: "failed",
                errorMessage: message,
              },
            },
          ]),
        );
      });

      return {
        threadId: input.threadId,
        turnId,
        resumeCursor: { sessionId: state.sessionId },
      } satisfies ProviderTurnStartResult;
    });

  const interruptTurn: OpenCodeAdapterShape["interruptTurn"] = (threadId, turnId) =>
    Effect.gen(function* () {
      const state = getStateByThreadId(threadId);
      if (!state) {
        return yield* missingSession(threadId);
      }

      const activeTurnId = turnId ?? state.activeTurnId;
      if (activeTurnId) {
        setState(state, {
          abortErrorSuppressionUntil: Date.now() + USER_ABORT_ERROR_SUPPRESSION_WINDOW_MS,
        });
      }
      yield* Effect.tryPromise({
        try: () => state.lease.client.session.abort({ sessionID: state.sessionId }, SDK_OPTIONS),
        catch: (cause) =>
          toRequestError(
            "session.abort",
            cause instanceof Error ? cause.message : "Failed to interrupt OpenCode turn.",
            cause,
          ),
      });

      if (activeTurnId && !state.terminalTurnIds.has(String(activeTurnId))) {
        state.terminalTurnIds.add(String(activeTurnId));
        setState(state, { activeTurnId: undefined, status: "ready" });
        yield* publishRuntimeEvents([
          {
            ...runtimeEventBase({ threadId, createdAt: state.updatedAt, turnId: activeTurnId }),
            type: "turn.aborted",
            payload: {
              reason: "Turn interrupted by user.",
            },
          },
        ]);
      }
    });

  const respondToRequest: OpenCodeAdapterShape["respondToRequest"] = (
    threadId,
    requestId,
    decision,
  ) =>
    Effect.gen(function* () {
      const state = getStateByThreadId(threadId);
      if (!state) {
        return yield* missingSession(threadId);
      }

      yield* Effect.tryPromise({
        try: () =>
          state.lease.client.permission.reply(
            {
              requestID: requestId,
              reply: toApprovalReply(decision),
            },
            SDK_OPTIONS,
          ),
        catch: (cause) =>
          toRequestError(
            "permission.reply",
            cause instanceof Error
              ? cause.message
              : "Failed to reply to OpenCode permission request.",
            cause,
          ),
      });
    });

  const respondToUserInput: OpenCodeAdapterShape["respondToUserInput"] = (
    threadId,
    requestId,
    answers,
  ) =>
    Effect.gen(function* () {
      const state = getStateByThreadId(threadId);
      if (!state) {
        return yield* missingSession(threadId);
      }

      const pending = yield* Effect.tryPromise({
        try: () => recoverPendingQuestionRequest(state, requestId),
        catch: (cause) =>
          toRequestError(
            "question.list",
            cause instanceof Error ? cause.message : "Failed to list pending OpenCode questions.",
            cause,
          ),
      });
      if (!pending) {
        return yield* new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "question.reply",
          detail: `Unknown pending OpenCode question request '${requestId}'.`,
        });
      }

      const questionAnswers = toQuestionAnswers(pending, answers);

      yield* Effect.tryPromise({
        try: () =>
          state.lease.client.question.reply(
            {
              requestID: requestId,
              answers: questionAnswers,
            },
            SDK_OPTIONS,
          ),
        catch: (cause) =>
          toRequestError(
            "question.reply",
            cause instanceof Error ? cause.message : "Failed to reply to OpenCode question.",
            cause,
          ),
      });

      state.pendingRequests.delete(requestId);
      yield* publishRuntimeEvents([
        {
          ...runtimeEventBase({
            threadId: state.threadId,
            createdAt: nowIso(),
            turnId: pending.turnId,
            itemId: pending.itemId,
            requestId: RuntimeRequestId.makeUnsafe(requestId),
          }),
          type: "user-input.resolved",
          payload: {
            answers: toUserInputAnswerRecord(pending, questionAnswers),
          },
        },
      ]);
    });

  const stopSession: OpenCodeAdapterShape["stopSession"] = (threadId) =>
    Effect.gen(function* () {
      const state = getStateByThreadId(threadId);
      if (!state) {
        return;
      }

      if (state.activeTurnId && !state.terminalTurnIds.has(String(state.activeTurnId))) {
        yield* Effect.tryPromise({
          try: () => state.lease.client.session.abort({ sessionID: state.sessionId }, SDK_OPTIONS),
          catch: (cause) =>
            toRequestError(
              "session.abort",
              cause instanceof Error ? cause.message : "Failed to interrupt OpenCode turn.",
              cause,
            ),
        }).pipe(Effect.catch(() => Effect.void));
      }

      sessions.delete(threadId);
      threadIdBySessionId.delete(state.sessionId);
      yield* state.lease.release;
      yield* stopWatcherIfUnused(state.lease.key);
    });

  const listSessions: OpenCodeAdapterShape["listSessions"] = () =>
    Effect.sync(() => Array.from(sessions.values(), toProviderSessionSnapshot));

  const hasSession: OpenCodeAdapterShape["hasSession"] = (threadId) =>
    Effect.succeed(sessions.has(threadId));

  const readThread: OpenCodeAdapterShape["readThread"] = (threadId) =>
    Effect.gen(function* () {
      const state = getStateByThreadId(threadId);
      if (!state) {
        return yield* missingSession(threadId);
      }

      const messages = yield* Effect.tryPromise({
        try: () => loadMessages(state),
        catch: (cause) =>
          toRequestError(
            "session.messages",
            cause instanceof Error ? cause.message : "Failed to read OpenCode session messages.",
            cause,
          ),
      });

      const turns = messages
        .filter((entry) => entry.info.role === "user")
        .map((entry) => {
          const relatedMessages = messages.filter(
            (candidate) =>
              candidate.info.id === entry.info.id ||
              (candidate.info.role === "assistant" && candidate.info.parentID === entry.info.id),
          );
          return {
            id: toTurnIdForUserMessage(entry.info.id),
            items: relatedMessages,
          };
        });

      return {
        threadId,
        turns,
      } satisfies ProviderThreadSnapshot;
    });

  const rollbackThread: OpenCodeAdapterShape["rollbackThread"] = (threadId, numTurns) =>
    Effect.gen(function* () {
      const state = getStateByThreadId(threadId);
      if (!state) {
        return yield* missingSession(threadId);
      }

      if (!Number.isInteger(numTurns) || numTurns < 1) {
        return yield* new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "rollbackThread",
          issue: "numTurns must be an integer >= 1.",
        });
      }

      const messages = yield* Effect.tryPromise({
        try: () => loadMessages(state),
        catch: (cause) =>
          toRequestError(
            "session.messages",
            cause instanceof Error ? cause.message : "Failed to read OpenCode session history.",
            cause,
          ),
      });
      const userMessages = messages.filter((entry) => entry.info.role === "user");
      if (userMessages.length === 0) {
        return {
          threadId,
          turns: [],
        } satisfies ProviderThreadSnapshot;
      }

      const boundaryIndex = Math.max(0, userMessages.length - numTurns);
      const boundaryMessage = userMessages[boundaryIndex];
      const nextSession = yield* Effect.tryPromise({
        try: () =>
          boundaryMessage
            ? state.lease.client.session
                .fork(
                  {
                    sessionID: state.sessionId,
                    messageID: boundaryMessage.info.id,
                  },
                  SDK_OPTIONS,
                )
                .then((result) => result.data as Session)
            : state.lease.client.session
                .create(
                  {
                    title: `T3 ${threadId}`,
                    permission: buildOpenCodePermissionRules(state.runtimeMode),
                  },
                  SDK_OPTIONS,
                )
                .then((result) => result.data as Session),
        catch: (cause) =>
          toRequestError(
            "session.fork",
            cause instanceof Error ? cause.message : "Failed to fork OpenCode session.",
            cause,
          ),
      });

      threadIdBySessionId.delete(state.sessionId);
      state.sessionId = nextSession.id;
      threadIdBySessionId.set(state.sessionId, threadId);
      state.terminalTurnIds.clear();
      state.knownPartKinds.clear();
      state.knownToolStatuses.clear();
      state.knownToolsByCallId.clear();
      state.pendingRequests.clear();
      setState(state, {
        activeTurnId: undefined,
        lastError: undefined,
        status: "ready",
      });

      const history = yield* Effect.tryPromise({
        try: () => loadSessionHistorySummary(state),
        catch: (cause) =>
          toRequestError(
            "session.messages",
            cause instanceof Error ? cause.message : "Failed to reload OpenCode session history.",
            cause,
          ),
      });
      state.orderedUserMessageIds = history.orderedUserMessageIds;
      state.lastCompletedTurnId = history.lastCompletedTurnId;

      return yield* readThread(threadId);
    });

  const stopAll: OpenCodeAdapterShape["stopAll"] = () =>
    Effect.gen(function* () {
      const threadIds = Array.from(sessions.keys());
      for (const threadId of threadIds) {
        yield* stopSession(threadId);
      }
    });

  yield* Effect.addFinalizer(() =>
    Effect.gen(function* () {
      yield* stopAll().pipe(Effect.catch(() => Effect.void));
      yield* Queue.shutdown(runtimeEventQueue);
    }),
  );

  return {
    provider: PROVIDER,
    capabilities: {
      sessionModelSwitch: "restart-session",
    },
    startSession,
    sendTurn,
    interruptTurn,
    respondToRequest,
    respondToUserInput,
    stopSession,
    listSessions,
    hasSession,
    readThread,
    rollbackThread,
    stopAll,
    streamEvents: Stream.fromQueue(runtimeEventQueue),
  } satisfies OpenCodeAdapterShape;
});

function resolveSessionForEvent(
  event: Event,
  getStateBySessionId: (sessionId: string) => OpenCodeSessionState | undefined,
): OpenCodeSessionState | undefined {
  const maybeProperties = "properties" in event ? event.properties : undefined;
  if (!maybeProperties || typeof maybeProperties !== "object") {
    return undefined;
  }

  const nestedInfo = "info" in maybeProperties ? maybeProperties.info : undefined;
  const nestedPart = "part" in maybeProperties ? maybeProperties.part : undefined;
  const sessionId =
    ("sessionID" in maybeProperties ? maybeProperties.sessionID : undefined) ??
    (nestedInfo && typeof nestedInfo === "object" && "sessionID" in nestedInfo
      ? nestedInfo.sessionID
      : undefined) ??
    (nestedPart && typeof nestedPart === "object" && "sessionID" in nestedPart
      ? nestedPart.sessionID
      : undefined);
  return typeof sessionId === "string" ? getStateBySessionId(sessionId) : undefined;
}

export const OpenCodeAdapterLive = Layer.effect(OpenCodeAdapter, makeOpenCodeAdapter);
