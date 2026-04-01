import assert from "node:assert/strict";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { ApprovalRequestId, ThreadId } from "@t3tools/contracts";
import { Effect, Layer, Schema, Stream } from "effect";
import { describe, it } from "@effect/vitest";

import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { ProviderAdapterRequestError } from "../Errors.ts";
import { OpenCodeAdapter } from "../Services/OpenCodeAdapter.ts";
import {
  OpenCodeServerPool,
  type OpenCodeServerPoolShape,
} from "../Services/OpenCodeServerPool.ts";
import { OpenCodeAdapterLive } from "./OpenCodeAdapter.ts";

const asThreadId = (value: string) => ThreadId.makeUnsafe(value);

class AsyncEventStream<T> implements AsyncIterable<T> {
  private readonly values: Array<T> = [];
  private readonly resolvers: Array<(result: IteratorResult<T>) => void> = [];
  private closed = false;

  push(value: T): void {
    const resolver = this.resolvers.shift();
    if (resolver) {
      resolver({ value, done: false });
      return;
    }
    this.values.push(value);
  }

  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    for (const resolver of this.resolvers.splice(0)) {
      resolver({ value: undefined, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        const value = this.values.shift();
        if (value !== undefined) {
          return Promise.resolve({ value, done: false });
        }
        if (this.closed) {
          return Promise.resolve({ value: undefined, done: true });
        }
        return new Promise<IteratorResult<T>>((resolve) => {
          this.resolvers.push(resolve);
        });
      },
    };
  }
}

class FakeOpenCodeClient {
  readonly createCalls: Array<unknown> = [];
  readonly getCalls: Array<unknown> = [];
  readonly messagesCalls: Array<unknown> = [];
  readonly messageCalls: Array<unknown> = [];
  readonly promptCalls: Array<unknown> = [];
  readonly abortCalls: Array<unknown> = [];
  readonly forkCalls: Array<unknown> = [];
  readonly permissionReplyCalls: Array<unknown> = [];
  readonly questionReplyCalls: Array<unknown> = [];

  readonly eventStream = new AsyncEventStream<any>();
  readonly messagesBySession = new Map<string, Array<any>>();
  readonly messageDetails = new Map<string, { parts: Array<any> }>();

  private readonly subscribed = Promise.withResolvers<void>();
  private createdSessionCount = 0;
  private forkedSessionCount = 0;
  promptAsyncImpl: ((input: unknown) => Promise<unknown>) | null = null;
  eventSubscribeImpl:
    | ((
        input: unknown,
        options?: { signal?: AbortSignal },
      ) => Promise<{ stream: AsyncIterable<any> }>)
    | null = null;

  session = {
    create: async (input: unknown) => {
      this.createCalls.push(input);
      this.createdSessionCount += 1;
      return {
        data: {
          id: `sess-created-${this.createdSessionCount}`,
          ...(typeof input === "object" && input !== null && "permission" in input
            ? { permission: (input as { permission?: unknown }).permission }
            : {}),
        },
      } as const;
    },
    get: async (input: { sessionID: string }) => {
      this.getCalls.push(input);
      return { data: { id: input.sessionID } } as const;
    },
    messages: async (input: { sessionID: string }) => {
      this.messagesCalls.push(input);
      return { data: this.messagesBySession.get(input.sessionID) ?? [] } as const;
    },
    message: async (input: { messageID: string }) => {
      this.messageCalls.push(input);
      return { data: this.messageDetails.get(input.messageID) ?? { parts: [] } } as const;
    },
    promptAsync: (input: unknown) => {
      this.promptCalls.push(input);
      if (this.promptAsyncImpl) {
        return this.promptAsyncImpl(input);
      }
      return Promise.resolve({} as const);
    },
    abort: async (input: unknown) => {
      this.abortCalls.push(input);
      return {} as const;
    },
    fork: async (input: unknown) => {
      this.forkCalls.push(input);
      this.forkedSessionCount += 1;
      return { data: { id: `sess-forked-${this.forkedSessionCount}` } } as const;
    },
  };

  permission = {
    reply: async (input: unknown) => {
      this.permissionReplyCalls.push(input);
      return {} as const;
    },
  };

  question = {
    reply: async (input: unknown) => {
      this.questionReplyCalls.push(input);
      return {} as const;
    },
  };

  event = {
    subscribe: async (_input: unknown, options?: { signal?: AbortSignal }) => {
      if (this.eventSubscribeImpl) {
        return this.eventSubscribeImpl(_input, options);
      }
      options?.signal?.addEventListener("abort", () => this.eventStream.close(), { once: true });
      this.subscribed.resolve();
      return { stream: this.eventStream } as const;
    },
  };

  pushEvent(event: unknown): void {
    this.eventStream.push(event);
  }

  async waitForSubscription(): Promise<void> {
    await Promise.race([
      this.subscribed.promise,
      new Promise<never>((_, reject) => {
        setTimeout(
          () => reject(new Error("Timed out waiting for OpenCode SSE subscription.")),
          1000,
        );
      }),
    ]);
  }
}

class OpenCodeAdapterHarness {
  readonly client = new FakeOpenCodeClient();
  readonly acquireCalls: Array<unknown> = [];
  readonly releaseCalls: Array<string> = [];

  readonly pool: OpenCodeServerPoolShape = {
    acquire: (input) => {
      this.acquireCalls.push(input);
      return Effect.succeed({
        key: "workspace:/repo",
        poolRoot: input.poolRoot ?? input.cwd,
        cwd: input.cwd,
        baseUrl: "http://127.0.0.1:9999",
        client: this.client as never,
        release: Effect.sync(() => {
          this.releaseCalls.push(input.cwd);
        }),
      });
    },
    loadProviderCatalog: () => Effect.die("unused"),
    stopAll: () => Effect.void,
    streamEvents: Stream.empty,
  };
}

function makeLayer(
  harness: OpenCodeAdapterHarness,
  serverSettingsOverrides?: Parameters<typeof ServerSettingsService.layerTest>[0],
) {
  return OpenCodeAdapterLive.pipe(
    Layer.provideMerge(Layer.succeed(OpenCodeServerPool, harness.pool)),
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), process.cwd())),
    Layer.provideMerge(ServerSettingsService.layerTest(serverSettingsOverrides)),
    Layer.provideMerge(NodeServices.layer),
  );
}

function collectRuntimeEvents(adapter: typeof OpenCodeAdapter.Service, count: number) {
  return Stream.runCollect(Stream.take(adapter.streamEvents, count)).pipe(
    Effect.map((events) => Array.from(events)),
  );
}

function drainRuntimeEvents(adapter: typeof OpenCodeAdapter.Service, count: number) {
  return collectRuntimeEvents(adapter, count).pipe(Effect.asVoid);
}

describe("OpenCodeAdapterLive", () => {
  it.effect("reuses resume cursors and honors the OpenCode binary override", () => {
    const harness = new OpenCodeAdapterHarness();
    return Effect.gen(function* () {
      harness.client.messagesBySession.set("sess-resumed", []);
      const adapter = yield* OpenCodeAdapter;

      const session = yield* adapter.startSession({
        provider: "opencode",
        threadId: asThreadId("thread-resume"),
        cwd: "/repo/worktree-a",
        providerOptions: {
          opencode: {
            binaryPath: "/opt/opencode/bin/opencode",
          },
        },
        resumeCursor: { sessionId: "sess-resumed" },
        runtimeMode: "full-access",
      });

      yield* Effect.promise(() => harness.client.waitForSubscription());
      const startupEvents = yield* collectRuntimeEvents(adapter, 3);

      assert.deepEqual(harness.acquireCalls[0], {
        cwd: "/repo/worktree-a",
        poolRoot: "/repo/worktree-a",
        binaryPath: "/opt/opencode/bin/opencode",
      });
      assert.deepEqual(harness.client.getCalls[0], { sessionID: "sess-resumed" });
      assert.equal(session.provider, "opencode");
      assert.deepEqual(session.resumeCursor, { sessionId: "sess-resumed" });
      assert.equal(startupEvents[0]?.type, "session.started");
      if (startupEvents[0]?.type === "session.started") {
        assert.equal(startupEvents[0].payload.message, "Recovered OpenCode session.");
      }
    }).pipe(Effect.provide(makeLayer(harness)));
  });

  it.effect(
    "uses the configured OpenCode binary path when no per-session override is provided",
    () => {
      const harness = new OpenCodeAdapterHarness();
      return Effect.gen(function* () {
        const adapter = yield* OpenCodeAdapter;

        yield* adapter.startSession({
          provider: "opencode",
          threadId: asThreadId("thread-settings-binary"),
          cwd: "/repo/worktree-settings",
          runtimeMode: "full-access",
        });

        assert.deepEqual(harness.acquireCalls[0], {
          cwd: "/repo/worktree-settings",
          poolRoot: "/repo/worktree-settings",
          binaryPath: "/srv/opencode-custom",
        });
      }).pipe(
        Effect.provide(
          makeLayer(harness, {
            providers: {
              opencode: {
                binaryPath: "/srv/opencode-custom",
              },
            },
          }),
        ),
      );
    },
  );

  it.effect("hydrates resumed OpenCode runtime mode from live session permission rules", () => {
    const harness = new OpenCodeAdapterHarness();
    return Effect.gen(function* () {
      harness.client.messagesBySession.set("sess-resumed-supervised", []);
      harness.client.session.get = async (input: { sessionID: string }) => {
        harness.client.getCalls.push(input);
        return {
          data: {
            id: input.sessionID,
            permission: [
              { permission: "*", pattern: "*", action: "allow" },
              { permission: "bash", pattern: "*", action: "ask" },
            ],
          },
        } as const;
      };
      const adapter = yield* OpenCodeAdapter;

      const session = yield* adapter.startSession({
        provider: "opencode",
        threadId: asThreadId("thread-resume-supervised"),
        cwd: "/repo/worktree-b",
        resumeCursor: { sessionId: "sess-resumed-supervised" },
        runtimeMode: "full-access",
      });

      assert.equal(session.runtimeMode, "approval-required");
    }).pipe(Effect.provide(makeLayer(harness)));
  });

  it.effect(
    "starts a fresh session and reports a fresh start when the resume cursor is stale",
    () => {
      const harness = new OpenCodeAdapterHarness();
      return Effect.gen(function* () {
        harness.client.messagesBySession.set("sess-created-1", []);
        harness.client.session.get = async (input: { sessionID: string }) => {
          harness.client.getCalls.push(input);
          throw new Error("session not found");
        };
        const adapter = yield* OpenCodeAdapter;

        const session = yield* adapter.startSession({
          provider: "opencode",
          threadId: asThreadId("thread-stale-resume"),
          cwd: "/repo/worktree-stale",
          resumeCursor: { sessionId: "sess-stale" },
          runtimeMode: "full-access",
        });

        yield* Effect.promise(() => harness.client.waitForSubscription());
        const startupEvents = yield* collectRuntimeEvents(adapter, 3);

        assert.deepEqual(harness.client.getCalls[0], { sessionID: "sess-stale" });
        assert.equal(harness.client.createCalls.length, 1);
        assert.deepEqual(session.resumeCursor, { sessionId: "sess-created-1" });
        assert.equal(startupEvents[0]?.type, "session.started");
        if (startupEvents[0]?.type === "session.started") {
          assert.equal(startupEvents[0].payload.message, "Started OpenCode session.");
          assert.deepEqual(startupEvents[0].payload.resume, { sessionId: "sess-created-1" });
        }
      }).pipe(Effect.provide(makeLayer(harness)));
    },
  );

  it.effect("treats tool-calls assistant history as an unfinished resumed turn", () => {
    const harness = new OpenCodeAdapterHarness();
    return Effect.gen(function* () {
      harness.client.messagesBySession.set("sess-resumed-tool-calls", [
        { info: { role: "user", id: "user-msg-1" } },
        {
          info: {
            role: "assistant",
            id: "assistant-msg-1",
            parentID: "user-msg-1",
            time: { completed: new Date().toISOString() },
            finish: "tool-calls",
          },
        },
      ]);
      const adapter = yield* OpenCodeAdapter;

      yield* adapter.startSession({
        provider: "opencode",
        threadId: asThreadId("thread-resume-tool-calls"),
        cwd: "/repo/tool-calls",
        resumeCursor: { sessionId: "sess-resumed-tool-calls" },
        runtimeMode: "full-access",
      });

      yield* Effect.promise(() => harness.client.waitForSubscription());
      const startupEvents = yield* collectRuntimeEvents(adapter, 4);

      assert.equal(startupEvents[0]?.type, "session.started");
      assert.equal(startupEvents[1]?.type, "thread.started");
      assert.equal(startupEvents[2]?.type, "session.state.changed");
      assert.equal(startupEvents[3]?.type, "turn.aborted");
      if (startupEvents[3]?.type === "turn.aborted") {
        assert.equal(startupEvents[3].turnId, "opencode:user-msg-1");
        assert.equal(
          startupEvents[3].payload.reason,
          "Recovered OpenCode session after sidecar loss; the in-flight turn cannot be resumed.",
        );
      }
    }).pipe(Effect.provide(makeLayer(harness)));
  });

  it.effect("fails session start when the OpenCode event stream cannot be established", () => {
    const harness = new OpenCodeAdapterHarness();
    return Effect.gen(function* () {
      harness.client.eventSubscribeImpl = async () => {
        throw new Error("event stream unavailable");
      };
      const adapter = yield* OpenCodeAdapter;

      const result = yield* adapter
        .startSession({
          provider: "opencode",
          threadId: asThreadId("thread-subscribe-failure"),
          cwd: "/repo/subscribe-failure",
          runtimeMode: "full-access",
        })
        .pipe(
          Effect.map((session) => ({ kind: "success" as const, session })),
          Effect.catch((error) => Effect.succeed({ kind: "failure" as const, error })),
        );

      assert.equal(result.kind, "failure");
      if (result.kind === "failure") {
        assert.ok(Schema.is(ProviderAdapterRequestError)(result.error));
        assert.equal(result.error.method, "event.subscribe");
        assert.match(result.error.detail, /event stream unavailable/);
      }

      const hasSession = yield* adapter.hasSession(asThreadId("thread-subscribe-failure"));
      assert.equal(hasSession, false);
      assert.deepEqual(harness.releaseCalls, ["/repo/subscribe-failure"]);
    }).pipe(Effect.provide(makeLayer(harness)));
  });

  it.effect("routes nested session IDs from OpenCode message events", () => {
    const harness = new OpenCodeAdapterHarness();
    return Effect.gen(function* () {
      harness.client.messagesBySession.set("sess-created-1", []);
      harness.client.messageDetails.set("assistant-nested-session", {
        parts: [{ type: "text", text: "NESTED_SESSION_OK" }],
      });
      const adapter = yield* OpenCodeAdapter;

      yield* adapter.startSession({
        provider: "opencode",
        threadId: asThreadId("thread-nested-session-id"),
        cwd: "/repo/nested-session-id",
        runtimeMode: "full-access",
      });
      yield* Effect.promise(() => harness.client.waitForSubscription());
      yield* drainRuntimeEvents(adapter, 3);

      const turn = yield* adapter.sendTurn({
        threadId: asThreadId("thread-nested-session-id"),
        input: "Run a command and then reply once",
        attachments: [],
      });
      yield* drainRuntimeEvents(adapter, 1);

      const parentMessageId = String(turn.turnId).replace("opencode:", "");

      harness.client.pushEvent({
        type: "message.part.updated",
        properties: {
          part: {
            id: "part-nested-session",
            sessionID: "sess-created-1",
            messageID: "assistant-nested-session",
            type: "tool",
            callID: "call-nested-session",
            tool: "bash",
            state: {
              status: "running",
              input: { command: "sleep 1" },
            },
          },
        },
      });

      const [toolStarted] = yield* collectRuntimeEvents(adapter, 1);
      assert.equal(toolStarted?.type, "item.started");
      if (toolStarted?.type === "item.started") {
        assert.equal(toolStarted.turnId, turn.turnId);
        assert.equal(toolStarted.payload.itemType, "command_execution");
      }

      harness.client.pushEvent({
        type: "message.updated",
        properties: {
          info: {
            id: "assistant-nested-session",
            parentID: parentMessageId,
            role: "assistant",
            agent: "build",
            providerID: "github-copilot",
            modelID: "gpt-5.4",
            sessionID: "sess-created-1",
            cost: 0,
            tokens: { total: 2, input: 1, output: 1, reasoning: 0, cache: { write: 0, read: 0 } },
            time: {
              created: new Date().toISOString(),
              completed: new Date().toISOString(),
            },
            finish: "stop",
            parts: [],
          },
        },
      });

      const settledEvents = yield* collectRuntimeEvents(adapter, 2);
      assert.equal(settledEvents[0]?.type, "item.completed");
      if (settledEvents[0]?.type === "item.completed") {
        assert.equal(settledEvents[0].payload.itemType, "assistant_message");
        assert.equal(settledEvents[0].payload.detail, "NESTED_SESSION_OK");
      }
      assert.equal(settledEvents[1]?.type, "turn.completed");
    }).pipe(Effect.provide(makeLayer(harness)));
  });

  it.effect("maps plan turns into promptAsync inputs and canonical turn.started events", () => {
    const harness = new OpenCodeAdapterHarness();
    return Effect.gen(function* () {
      harness.client.messagesBySession.set("sess-created-1", []);
      const adapter = yield* OpenCodeAdapter;

      yield* adapter.startSession({
        provider: "opencode",
        threadId: asThreadId("thread-send"),
        cwd: "/repo",
        runtimeMode: "full-access",
      });
      yield* Effect.promise(() => harness.client.waitForSubscription());
      yield* drainRuntimeEvents(adapter, 3);

      const turn = yield* adapter.sendTurn({
        threadId: asThreadId("thread-send"),
        input: "Plan the refactor",
        modelSelection: {
          provider: "opencode",
          model: "anthropic/claude-sonnet-4.5",
        },
        interactionMode: "plan",
        attachments: [],
      });
      const [event] = yield* collectRuntimeEvents(adapter, 1);

      const promptCall = harness.client.promptCalls[0] as {
        sessionID: string;
        messageID: string;
        model: { providerID: string; modelID: string };
        agent: string;
        parts: Array<{ type: string; text?: string }>;
      };

      assert.equal(promptCall.sessionID, "sess-created-1");
      assert.deepEqual(promptCall.model, {
        providerID: "anthropic",
        modelID: "claude-sonnet-4.5",
      });
      assert.equal(promptCall.agent, "plan");
      assert.deepEqual(promptCall.parts, [{ type: "text", text: "Plan the refactor" }]);
      assert.equal(turn.turnId, `opencode:${promptCall.messageID}`);
      assert.equal(event?.type, "turn.started");
      if (event?.type === "turn.started") {
        assert.equal(event.payload.model, "anthropic/claude-sonnet-4.5");
      }
    }).pipe(Effect.provide(makeLayer(harness)));
  });

  it.effect("does not wait for promptAsync to settle before reporting turn.started", () => {
    const harness = new OpenCodeAdapterHarness();
    return Effect.gen(function* () {
      harness.client.messagesBySession.set("sess-created-1", []);
      const promptAsyncStarted = yield* Effect.promise(() =>
        Promise.resolve(Promise.withResolvers<void>()),
      );
      harness.client.promptAsyncImpl = async () => {
        promptAsyncStarted.resolve();
        return await new Promise(() => {
          // Intentionally never resolve: this simulates a provider API that
          // accepts the prompt but keeps the request promise pending while the
          // turn runs over SSE.
        });
      };
      const adapter = yield* OpenCodeAdapter;

      yield* adapter.startSession({
        provider: "opencode",
        threadId: asThreadId("thread-send-pending"),
        cwd: "/repo",
        runtimeMode: "full-access",
      });
      yield* Effect.promise(() => harness.client.waitForSubscription());
      yield* drainRuntimeEvents(adapter, 3);

      const sendTurnExit = yield* Effect.promise(() =>
        Effect.runPromiseExit(
          adapter
            .sendTurn({
              threadId: asThreadId("thread-send-pending"),
              input: "Hello pending prompt",
              attachments: [],
            })
            .pipe(Effect.timeoutOption("100 millis")),
        ),
      );

      yield* Effect.promise(() => promptAsyncStarted.promise);

      assert.equal(harness.client.promptCalls.length, 1);
      assert.equal(sendTurnExit._tag, "Success");
      if (sendTurnExit._tag === "Success") {
        assert.equal(sendTurnExit.value._tag, "Some");
      }
    }).pipe(Effect.provide(makeLayer(harness)));
  });

  it.effect("emits terminal failure events when promptAsync rejects immediately", () => {
    const harness = new OpenCodeAdapterHarness();
    return Effect.gen(function* () {
      harness.client.messagesBySession.set("sess-created-1", []);
      harness.client.promptAsyncImpl = async () => {
        throw new Error("prompt failed immediately");
      };
      const adapter = yield* OpenCodeAdapter;

      yield* adapter.startSession({
        provider: "opencode",
        threadId: asThreadId("thread-send-immediate-reject"),
        cwd: "/repo",
        runtimeMode: "full-access",
      });
      yield* Effect.promise(() => harness.client.waitForSubscription());
      yield* drainRuntimeEvents(adapter, 3);

      const result = yield* adapter
        .sendTurn({
          threadId: asThreadId("thread-send-immediate-reject"),
          input: "Fail immediately",
          attachments: [],
        })
        .pipe(
          Effect.map((turn) => ({ kind: "success" as const, turn })),
          Effect.catch((error) => Effect.succeed({ kind: "failure" as const, error })),
        );

      assert.equal(result.kind, "failure");
      if (result.kind === "failure") {
        assert.ok(Schema.is(ProviderAdapterRequestError)(result.error));
        assert.equal(result.error.method, "session.promptAsync");
        assert.match(result.error.detail, /prompt failed immediately/);
      }

      const failureEventsExit = yield* Effect.promise(() =>
        Effect.runPromiseExit(
          collectRuntimeEvents(adapter, 3).pipe(Effect.timeoutOption("250 millis")),
        ),
      );
      assert.equal(failureEventsExit._tag, "Success");
      if (failureEventsExit._tag === "Success") {
        assert.equal(failureEventsExit.value._tag, "Some");
        if (failureEventsExit.value._tag === "Some") {
          const failureEvents = failureEventsExit.value.value;
          assert.equal(failureEvents[0]?.type, "turn.started");
          assert.equal(failureEvents[1]?.type, "runtime.error");
          if (failureEvents[1]?.type === "runtime.error") {
            assert.equal(failureEvents[1].payload.message, "prompt failed immediately");
          }
          assert.equal(failureEvents[2]?.type, "turn.completed");
          if (failureEvents[2]?.type === "turn.completed") {
            assert.equal(failureEvents[2].payload.state, "failed");
            assert.equal(failureEvents[2].payload.errorMessage, "prompt failed immediately");
          }
        }
      }

      const sessions = yield* adapter.listSessions();
      assert.equal(sessions[0]?.status, "error");
      assert.equal(sessions[0]?.activeTurnId, undefined);
    }).pipe(Effect.provide(makeLayer(harness)));
  });

  it.effect("does not let an idle status block later turn activity", () => {
    const harness = new OpenCodeAdapterHarness();
    return Effect.gen(function* () {
      harness.client.messagesBySession.set("sess-created-1", []);
      const adapter = yield* OpenCodeAdapter;

      yield* adapter.startSession({
        provider: "opencode",
        threadId: asThreadId("thread-idle-after-start"),
        cwd: "/repo",
        runtimeMode: "full-access",
      });
      yield* Effect.promise(() => harness.client.waitForSubscription());
      yield* drainRuntimeEvents(adapter, 3);

      const turn = yield* adapter.sendTurn({
        threadId: asThreadId("thread-idle-after-start"),
        input: "Run a long task",
        attachments: [],
      });
      yield* drainRuntimeEvents(adapter, 1);

      harness.client.pushEvent({
        type: "session.status",
        properties: {
          sessionID: "sess-created-1",
          status: { type: "idle" },
        },
      });
      harness.client.pushEvent({
        type: "message.part.updated",
        properties: {
          sessionID: "sess-created-1",
          part: {
            id: "part-tool-1",
            type: "tool",
            callID: "call-1",
            tool: "bash",
            state: {
              status: "running",
              input: { command: "sleep 65" },
            },
          },
        },
      });

      const firstEventExit = yield* Effect.promise(() =>
        Effect.runPromiseExit(
          collectRuntimeEvents(adapter, 1).pipe(Effect.timeoutOption("1000 millis")),
        ),
      );

      assert.equal(firstEventExit._tag, "Success");
      if (firstEventExit._tag === "Success") {
        assert.equal(firstEventExit.value._tag, "Some");
        if (firstEventExit.value._tag === "Some") {
          const [event] = firstEventExit.value.value;
          assert.equal(event?.type, "item.started");
          if (event?.type === "item.started") {
            assert.equal(event.turnId, turn.turnId);
            assert.equal(event.payload.itemType, "command_execution");
          }
        }
      }

      const lateEventExit = yield* Effect.promise(() =>
        Effect.runPromiseExit(
          collectRuntimeEvents(adapter, 1).pipe(Effect.timeoutOption("2500 millis")),
        ),
      );

      assert.equal(lateEventExit._tag, "Success");
      if (lateEventExit._tag === "Success") {
        assert.equal(lateEventExit.value._tag, "None");
      }
    }).pipe(Effect.provide(makeLayer(harness)));
  });

  it.effect(
    "aborts the turn if the session goes idle again after mid-turn activity without completion",
    () => {
      const harness = new OpenCodeAdapterHarness();
      return Effect.gen(function* () {
        harness.client.messagesBySession.set("sess-created-1", []);
        const adapter = yield* OpenCodeAdapter;

        yield* adapter.startSession({
          provider: "opencode",
          threadId: asThreadId("thread-idle-after-activity"),
          cwd: "/repo",
          runtimeMode: "full-access",
        });
        yield* Effect.promise(() => harness.client.waitForSubscription());
        yield* drainRuntimeEvents(adapter, 3);

        const turn = yield* adapter.sendTurn({
          threadId: asThreadId("thread-idle-after-activity"),
          input: "Run a long task and then stall",
          attachments: [],
        });
        yield* drainRuntimeEvents(adapter, 1);

        harness.client.pushEvent({
          type: "session.status",
          properties: {
            sessionID: "sess-created-1",
            status: { type: "idle" },
          },
        });
        harness.client.pushEvent({
          type: "message.part.updated",
          properties: {
            sessionID: "sess-created-1",
            part: {
              id: "part-tool-activity",
              type: "tool",
              callID: "call-activity",
              tool: "bash",
              state: {
                status: "running",
                input: { command: "sleep 65" },
              },
            },
          },
        });

        const [toolStarted] = yield* collectRuntimeEvents(adapter, 1);
        assert.equal(toolStarted?.type, "item.started");

        harness.client.pushEvent({
          type: "session.status",
          properties: {
            sessionID: "sess-created-1",
            status: { type: "idle" },
          },
        });

        const abortExit = yield* Effect.promise(() =>
          Effect.runPromiseExit(
            collectRuntimeEvents(adapter, 1).pipe(Effect.timeoutOption("2500 millis")),
          ),
        );

        assert.equal(abortExit._tag, "Success");
        if (abortExit._tag === "Success") {
          assert.equal(abortExit.value._tag, "Some");
          if (abortExit.value._tag === "Some") {
            const [event] = abortExit.value.value;
            assert.equal(event?.type, "turn.aborted");
            if (event?.type === "turn.aborted") {
              assert.equal(event.turnId, turn.turnId);
              assert.equal(
                event.payload.reason,
                "OpenCode session became idle before completing the active turn.",
              );
            }
          }
        }
      }).pipe(Effect.provide(makeLayer(harness)));
    },
  );

  it.effect("waits for the final assistant completion after tool-calls finish", () => {
    const harness = new OpenCodeAdapterHarness();
    return Effect.gen(function* () {
      harness.client.messagesBySession.set("sess-created-1", []);
      harness.client.messageDetails.set("assistant-final", {
        parts: [{ type: "text", text: "PEEKABOO_TIMEOUT_FIX_FINAL" }],
      });
      const adapter = yield* OpenCodeAdapter;

      yield* adapter.startSession({
        provider: "opencode",
        threadId: asThreadId("thread-tool-calls-finish"),
        cwd: "/repo",
        runtimeMode: "full-access",
      });
      yield* Effect.promise(() => harness.client.waitForSubscription());
      yield* drainRuntimeEvents(adapter, 3);

      const turn = yield* adapter.sendTurn({
        threadId: asThreadId("thread-tool-calls-finish"),
        input: "Run sleep 65 and then reply with a token",
        attachments: [],
      });
      yield* drainRuntimeEvents(adapter, 1);

      const parentMessageId = String(turn.turnId).replace("opencode:", "");

      harness.client.pushEvent({
        type: "message.updated",
        properties: {
          sessionID: "sess-created-1",
          info: {
            id: "assistant-intermediate",
            parentID: parentMessageId,
            role: "assistant",
            agent: "build",
            providerID: "github-copilot",
            modelID: "gpt-5.4",
            sessionID: "sess-created-1",
            cost: 0,
            tokens: { total: 10, input: 5, output: 5, reasoning: 0, cache: { write: 0, read: 0 } },
            time: {
              created: new Date().toISOString(),
              completed: new Date().toISOString(),
            },
            finish: "tool-calls",
            parts: [],
          },
        },
      });

      const prematureSettle = yield* Effect.promise(() =>
        Effect.runPromiseExit(
          collectRuntimeEvents(adapter, 1).pipe(Effect.timeoutOption("250 millis")),
        ),
      );

      assert.equal(prematureSettle._tag, "Success");
      if (prematureSettle._tag === "Success") {
        assert.equal(prematureSettle.value._tag, "None");
      }

      harness.client.pushEvent({
        type: "message.part.updated",
        properties: {
          sessionID: "sess-created-1",
          part: {
            id: "part-tool-final",
            type: "tool",
            callID: "call-final",
            tool: "bash",
            state: {
              status: "completed",
              input: { command: "sleep 65" },
              output: "",
              title: "Sleeps for 65 seconds",
            },
          },
        },
      });

      harness.client.pushEvent({
        type: "message.part.updated",
        properties: {
          sessionID: "sess-created-1",
          part: {
            id: "part-tool-final",
            type: "tool",
            callID: "call-final",
            tool: "bash",
            state: {
              status: "completed",
              input: { command: "sleep 65" },
              output: "",
              title: "Sleeps for 65 seconds",
            },
          },
        },
      });

      const toolEvents = yield* collectRuntimeEvents(adapter, 2);
      assert.equal(toolEvents[0]?.type, "item.started");
      assert.equal(toolEvents[1]?.type, "item.completed");

      harness.client.pushEvent({
        type: "message.updated",
        properties: {
          sessionID: "sess-created-1",
          info: {
            id: "assistant-final",
            parentID: parentMessageId,
            role: "assistant",
            agent: "build",
            providerID: "github-copilot",
            modelID: "gpt-5.4",
            sessionID: "sess-created-1",
            cost: 0,
            tokens: {
              total: 20,
              input: 10,
              output: 10,
              reasoning: 0,
              cache: { write: 0, read: 0 },
            },
            time: {
              created: new Date().toISOString(),
              completed: new Date().toISOString(),
            },
            finish: "stop",
            parts: [],
          },
        },
      });

      const settledEvents = yield* collectRuntimeEvents(adapter, 2);

      assert.equal(settledEvents[0]?.type, "item.completed");
      if (settledEvents[0]?.type === "item.completed") {
        assert.equal(settledEvents[0].turnId, turn.turnId);
        assert.equal(settledEvents[0].payload.itemType, "assistant_message");
        assert.equal(settledEvents[0].payload.detail, "PEEKABOO_TIMEOUT_FIX_FINAL");
      }

      assert.equal(settledEvents[1]?.type, "turn.completed");
      if (settledEvents[1]?.type === "turn.completed") {
        assert.equal(settledEvents[1].turnId, turn.turnId);
        assert.equal(settledEvents[1].payload.state, "completed");
        assert.equal(settledEvents[1].payload.stopReason, "stop");
      }
    }).pipe(Effect.provide(makeLayer(harness)));
  });

  it.effect("maps OpenCode permission requests into canonical approval events", () => {
    const harness = new OpenCodeAdapterHarness();
    return Effect.gen(function* () {
      harness.client.messagesBySession.set("sess-created-1", []);
      const adapter = yield* OpenCodeAdapter;

      yield* adapter.startSession({
        provider: "opencode",
        threadId: asThreadId("thread-permission"),
        cwd: "/repo",
        runtimeMode: "full-access",
      });
      yield* Effect.promise(() => harness.client.waitForSubscription());
      yield* drainRuntimeEvents(adapter, 3);

      yield* adapter.sendTurn({
        threadId: asThreadId("thread-permission"),
        input: "Run the check",
        attachments: [],
      });
      yield* drainRuntimeEvents(adapter, 1);

      harness.client.pushEvent({
        type: "permission.asked",
        properties: {
          sessionID: "sess-created-1",
          id: "perm-1",
          permission: "bash",
          patterns: ["git status"],
        },
      });
      const [opened] = yield* collectRuntimeEvents(adapter, 1);

      assert.equal(opened?.type, "request.opened");
      if (opened?.type === "request.opened") {
        assert.equal(opened.requestId, "perm-1");
        assert.equal(opened.payload.requestType, "command_execution_approval");
      }

      yield* adapter.respondToRequest(
        asThreadId("thread-permission"),
        ApprovalRequestId.makeUnsafe("perm-1"),
        "acceptForSession",
      );
      assert.deepEqual(harness.client.permissionReplyCalls[0], {
        requestID: "perm-1",
        reply: "always",
      });
    }).pipe(Effect.provide(makeLayer(harness)));
  });

  it.effect("maps OpenCode question flows into canonical user-input events", () => {
    const harness = new OpenCodeAdapterHarness();
    return Effect.gen(function* () {
      harness.client.messagesBySession.set("sess-created-1", []);
      const adapter = yield* OpenCodeAdapter;

      yield* adapter.startSession({
        provider: "opencode",
        threadId: asThreadId("thread-question"),
        cwd: "/repo",
        runtimeMode: "full-access",
      });
      yield* Effect.promise(() => harness.client.waitForSubscription());
      yield* drainRuntimeEvents(adapter, 3);

      yield* adapter.sendTurn({
        threadId: asThreadId("thread-question"),
        input: "Need structured input",
        attachments: [],
      });
      yield* drainRuntimeEvents(adapter, 1);

      harness.client.pushEvent({
        type: "question.asked",
        properties: {
          sessionID: "sess-created-1",
          id: "question-1",
          questions: [
            {
              header: "scope",
              question: "What scope should I use?",
              options: [{ label: "repo", description: "Repository root" }],
            },
            {
              header: "mode",
              question: "Which mode should I use?",
              options: [{ label: "fast", description: "Fast path" }],
              multiple: true,
              custom: false,
            },
          ],
        },
      });
      const [requested] = yield* collectRuntimeEvents(adapter, 1);

      assert.equal(requested?.type, "user-input.requested");
      yield* adapter.respondToUserInput(
        asThreadId("thread-question"),
        ApprovalRequestId.makeUnsafe("question-1"),
        {
          scope: "repo",
          mode: ["fast", "careful"],
        },
      );
      assert.deepEqual(harness.client.questionReplyCalls[0], {
        requestID: "question-1",
        answers: [["repo"], ["fast", "careful"]],
      });
    }).pipe(Effect.provide(makeLayer(harness)));
  });

  it.effect("aborts the active OpenCode turn when interrupted by the user", () => {
    const harness = new OpenCodeAdapterHarness();
    return Effect.gen(function* () {
      harness.client.messagesBySession.set("sess-created-1", []);
      const adapter = yield* OpenCodeAdapter;

      yield* adapter.startSession({
        provider: "opencode",
        threadId: asThreadId("thread-interrupt"),
        cwd: "/repo",
        runtimeMode: "full-access",
      });
      yield* Effect.promise(() => harness.client.waitForSubscription());
      yield* drainRuntimeEvents(adapter, 3);

      const turn = yield* adapter.sendTurn({
        threadId: asThreadId("thread-interrupt"),
        input: "Interrupt this turn",
        attachments: [],
      });
      yield* drainRuntimeEvents(adapter, 1);

      yield* adapter.interruptTurn(asThreadId("thread-interrupt"));
      const [aborted] = yield* collectRuntimeEvents(adapter, 1);
      const sessions = yield* adapter.listSessions();

      assert.deepEqual(harness.client.abortCalls[0], {
        sessionID: "sess-created-1",
      });
      assert.equal(aborted?.type, "turn.aborted");
      if (aborted?.type === "turn.aborted") {
        assert.equal(aborted.turnId, turn.turnId);
        assert.deepEqual(aborted.payload, {
          reason: "Turn interrupted by user.",
        });
      }
      assert.equal(sessions[0]?.status, "ready");
      assert.equal(sessions[0]?.activeTurnId, undefined);
    }).pipe(Effect.provide(makeLayer(harness)));
  });

  it.effect("forks and rebinds the OpenCode session when rolling back", () => {
    const harness = new OpenCodeAdapterHarness();
    return Effect.gen(function* () {
      harness.client.messagesBySession.set("sess-created-1", [
        { info: { role: "user", id: "user-msg-1" } },
        {
          info: {
            role: "assistant",
            id: "assistant-msg-1",
            parentID: "user-msg-1",
            time: { completed: new Date().toISOString() },
          },
        },
        { info: { role: "user", id: "user-msg-2" } },
        {
          info: {
            role: "assistant",
            id: "assistant-msg-2",
            parentID: "user-msg-2",
            time: { completed: new Date().toISOString() },
          },
        },
      ]);
      harness.client.messagesBySession.set("sess-forked-1", [
        { info: { role: "user", id: "user-msg-1" } },
        {
          info: {
            role: "assistant",
            id: "assistant-msg-1",
            parentID: "user-msg-1",
            time: { completed: new Date().toISOString() },
          },
        },
      ]);
      const adapter = yield* OpenCodeAdapter;

      yield* adapter.startSession({
        provider: "opencode",
        threadId: asThreadId("thread-rollback"),
        cwd: "/repo",
        runtimeMode: "full-access",
      });
      yield* Effect.promise(() => harness.client.waitForSubscription());
      yield* drainRuntimeEvents(adapter, 3);

      const snapshot = yield* adapter.rollbackThread(asThreadId("thread-rollback"), 1);
      const sessions = yield* adapter.listSessions();

      assert.deepEqual(harness.client.forkCalls[0], {
        sessionID: "sess-created-1",
        messageID: "user-msg-2",
      });
      assert.equal(snapshot.turns.length, 1);
      assert.equal(snapshot.turns[0]?.id, "opencode:user-msg-1");
      assert.deepEqual(sessions[0]?.resumeCursor, { sessionId: "sess-forked-1" });
    }).pipe(Effect.provide(makeLayer(harness)));
  });
});
