import { createHmac, createSign, randomUUID, timingSafeEqual } from "node:crypto";

import {
  CommandId,
  DEFAULT_MODEL_BY_PROVIDER,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  MessageId,
  ThreadId,
  type GithubAppSecretsStatus,
  type GithubAppSecretsUpdate,
  type ModelSelection,
} from "@t3tools/contracts";
import { Duration, Effect, FileSystem, Layer, Path, Ref } from "effect";
import * as Semaphore from "effect/Semaphore";

import { ServerConfig } from "../../config.ts";
import { GitCore } from "../../git/Services/GitCore.ts";
import { GitManager } from "../../git/Services/GitManager.ts";
import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine";
import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery";
import { GithubTaskLinkRepository } from "../../persistence/Services/GithubTaskLinks.ts";
import { GithubWebhookDeliveryRepository } from "../../persistence/Services/GithubWebhookDeliveries.ts";
import { GithubWorktreeCleanupJobRepository } from "../../persistence/Services/GithubWorktreeCleanupJobs.ts";
import { ProviderRegistry } from "../../provider/Services/ProviderRegistry";
import { ServerSettingsService } from "../../serverSettings";
import {
  GithubAppAutomation,
  GithubAppAutomationError,
  type GithubAppAutomationShape,
  type GithubWebhookRequest,
  type GithubWebhookResponse,
} from "../Services/GithubAppAutomation.ts";

type StoredGithubAppSecrets = {
  privateKeyPem?: string;
  webhookSecret?: string;
};

type ParsedRepo = {
  owner: string;
  name: string;
};

type StartContext = {
  installationId: number;
  repo: ParsedRepo;
  sourceType: "issue" | "pr";
  sourceNumber: number;
  prNumber: number | null;
  issueNumberForComment: number;
  senderLogin: string;
  title: string;
  body: string;
  commentBody: string;
  commandSuffix: string | null;
};

const CLEANUP_RETRY_BACKOFF_MS: readonly number[] = [
  30_000,
  60_000,
  5 * 60_000,
  15 * 60_000,
  30 * 60_000,
];
const CLEANUP_MAX_ATTEMPTS = 6;

const githubAppError = (operation: string, detail: string, cause?: unknown) =>
  new GithubAppAutomationError({ operation, detail, ...(cause !== undefined ? { cause } : {}) });

const toNonEmptyString = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

const toPositiveInt = (value: unknown): number | null => {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    return null;
  }
  return value;
};

const parseRepoFromRemoteUrl = (url: string | null): ParsedRepo | null => {
  const trimmed = url?.trim() ?? "";
  if (trimmed.length === 0) {
    return null;
  }
  const match =
    /^(?:git@github\.com:|ssh:\/\/git@github\.com\/|https:\/\/github\.com\/|git:\/\/github\.com\/)([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i.exec(
      trimmed,
    );
  const owner = match?.[1]?.trim() ?? "";
  const name = match?.[2]?.trim() ?? "";
  if (owner.length === 0 || name.length === 0) {
    return null;
  }
  return { owner, name };
};

const hasStartTrigger = (commentBody: string, botLogin: string): boolean => {
  const escapedLogin = botLogin.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const mentionPattern = new RegExp(`@${escapedLogin}\\b`, "i");
  if (!mentionPattern.test(commentBody)) {
    return false;
  }
  return /(^|\s)\/start(\s|$)/i.test(commentBody);
};

const extractStartSuffix = (commentBody: string): string | null => {
  const match = /\/start\b([\s\S]*)/i.exec(commentBody);
  const suffix = match?.[1]?.trim() ?? "";
  return suffix.length > 0 ? suffix : null;
};

const buildStartMessage = (input: {
  repo: ParsedRepo;
  sourceType: "issue" | "pr";
  sourceNumber: number;
  title: string;
  body: string;
  commentBody: string;
  commandSuffix: string | null;
}) => {
  const lines = [
    `GitHub ${input.sourceType === "pr" ? "PR" : "issue"} kickoff`,
    `Repository: ${input.repo.owner}/${input.repo.name}`,
    `${input.sourceType === "pr" ? "PR" : "Issue"} #${input.sourceNumber}: ${input.title}`,
  ];
  if (input.body.trim().length > 0) {
    lines.push("", "Original description:", input.body.trim());
  }
  lines.push("", "Triggering comment:", input.commentBody.trim());
  if (input.commandSuffix) {
    lines.push("", "Additional /start instructions:", input.commandSuffix);
  }
  return lines.join("\n");
};

const headerToString = (headerValue: string | string[] | undefined): string | null => {
  if (typeof headerValue === "string") {
    const trimmed = headerValue.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  if (!headerValue || headerValue.length === 0) {
    return null;
  }
  const first = headerValue[0]?.trim() ?? "";
  return first.length > 0 ? first : null;
};

const trimErrorMessage = (value: unknown): string => {
  const raw =
    value instanceof Error
      ? value.message
      : typeof value === "string"
        ? value
        : JSON.stringify(value);
  const trimmed = raw.trim();
  if (trimmed.length <= 500) {
    return trimmed;
  }
  return `${trimmed.slice(0, 500)}…`;
};

const makeGithubAppAutomation = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const serverConfig = yield* ServerConfig;
  const serverSettings = yield* ServerSettingsService;
  const providerRegistry = yield* ProviderRegistry;
  const gitCore = yield* GitCore;
  const gitManager = yield* GitManager;
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
  const orchestrationEngine = yield* OrchestrationEngineService;
  const webhookDeliveries = yield* GithubWebhookDeliveryRepository;
  const taskLinks = yield* GithubTaskLinkRepository;
  const cleanupJobs = yield* GithubWorktreeCleanupJobRepository;
  const writeSemaphore = yield* Semaphore.make(1);
  const startedRef = yield* Ref.make(false);

  const secretsPath = path.join(serverConfig.stateDir, "github-app-secrets.json");

  const readStoredSecrets = () =>
    Effect.gen(function* () {
      const exists = yield* fs
        .exists(secretsPath)
        .pipe(
          Effect.mapError((cause) =>
            githubAppError("readStoredSecrets", "Failed to check secrets file.", cause),
          ),
        );
      if (!exists) {
        return {};
      }
      const raw = yield* fs
        .readFileString(secretsPath)
        .pipe(
          Effect.mapError((cause) =>
            githubAppError("readStoredSecrets", "Failed to read secrets file.", cause),
          ),
        );
      return yield* Effect.try({
        try: () => {
          const parsed = JSON.parse(raw) as StoredGithubAppSecrets;
          return {
            ...(typeof parsed.privateKeyPem === "string" && parsed.privateKeyPem.length > 0
              ? { privateKeyPem: parsed.privateKeyPem }
              : {}),
            ...(typeof parsed.webhookSecret === "string" && parsed.webhookSecret.length > 0
              ? { webhookSecret: parsed.webhookSecret.trim() }
              : {}),
          };
        },
        catch: (cause) =>
          githubAppError("readStoredSecrets", "Secrets file contains invalid JSON.", cause),
      });
    });

  const writeStoredSecrets = (secrets: StoredGithubAppSecrets) =>
    writeSemaphore.withPermits(1)(
      Effect.gen(function* () {
        const tempPath = `${secretsPath}.${process.pid}.${Date.now()}.tmp`;
        yield* fs
          .makeDirectory(path.dirname(secretsPath), { recursive: true })
          .pipe(
            Effect.mapError((cause) =>
              githubAppError("writeStoredSecrets", "Failed to create secrets directory.", cause),
            ),
          );
        yield* fs
          .writeFileString(tempPath, `${JSON.stringify(secrets, null, 2)}\n`)
          .pipe(
            Effect.mapError((cause) =>
              githubAppError("writeStoredSecrets", "Failed to write temp secrets file.", cause),
            ),
          );
        yield* fs
          .rename(tempPath, secretsPath)
          .pipe(
            Effect.mapError((cause) =>
              githubAppError("writeStoredSecrets", "Failed to persist secrets file.", cause),
            ),
          );
        yield* fs.remove(tempPath, { force: true }).pipe(Effect.ignore({ log: true }));
      }),
    );

  const getSecretsStatus: GithubAppAutomationShape["getSecretsStatus"] = readStoredSecrets().pipe(
    Effect.map(
      (secrets): GithubAppSecretsStatus => ({
        hasPrivateKey:
          typeof secrets.privateKeyPem === "string" && secrets.privateKeyPem.trim().length > 0,
        hasWebhookSecret:
          typeof secrets.webhookSecret === "string" && secrets.webhookSecret.trim().length > 0,
      }),
    ),
    Effect.catch(() =>
      Effect.succeed({
        hasPrivateKey: false,
        hasWebhookSecret: false,
      } satisfies GithubAppSecretsStatus),
    ),
  );

  const updateSecrets: GithubAppAutomationShape["updateSecrets"] = (
    patch: GithubAppSecretsUpdate,
  ) =>
    Effect.gen(function* () {
      const current = yield* readStoredSecrets();
      const next: StoredGithubAppSecrets = { ...current };

      if ("privateKeyPem" in patch) {
        const value = patch.privateKeyPem;
        const normalized = value === null ? "" : (value ?? "").trim();
        if (normalized.length === 0) {
          delete next.privateKeyPem;
        } else {
          next.privateKeyPem = value ?? "";
        }
      }
      if ("webhookSecret" in patch) {
        const value = patch.webhookSecret;
        const normalized = value === null ? "" : (value ?? "").trim();
        if (normalized.length === 0) {
          delete next.webhookSecret;
        } else {
          next.webhookSecret = normalized;
        }
      }

      yield* writeStoredSecrets(next);
      return {
        hasPrivateKey:
          typeof next.privateKeyPem === "string" && next.privateKeyPem.trim().length > 0,
        hasWebhookSecret:
          typeof next.webhookSecret === "string" && next.webhookSecret.trim().length > 0,
      } satisfies GithubAppSecretsStatus;
    }).pipe(Effect.catch(() => getSecretsStatus));

  const createAppJwt = (appId: string, privateKeyPem: string) =>
    Effect.try({
      try: () => {
        const now = Math.floor(Date.now() / 1000);
        const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString(
          "base64url",
        );
        const payload = Buffer.from(
          JSON.stringify({
            iat: now - 60,
            exp: now + 9 * 60,
            iss: appId,
          }),
        ).toString("base64url");
        const signingInput = `${header}.${payload}`;
        const signature = createSign("RSA-SHA256")
          .update(signingInput)
          .sign(privateKeyPem, "base64url");
        return `${signingInput}.${signature}`;
      },
      catch: (cause) => githubAppError("createAppJwt", "Failed to create GitHub app JWT.", cause),
    });

  const githubApiRequest = (input: {
    method: string;
    path: string;
    token: string;
    body?: unknown;
  }) =>
    Effect.tryPromise({
      try: async () => {
        const response = await fetch(`https://api.github.com${input.path}`, {
          method: input.method,
          headers: {
            Accept: "application/vnd.github+json",
            Authorization: `Bearer ${input.token}`,
            "Content-Type": "application/json",
            "User-Agent": "t3code-github-app",
            "X-GitHub-Api-Version": "2022-11-28",
          },
          ...(input.body !== undefined ? { body: JSON.stringify(input.body) } : {}),
        });
        const text = await response.text();
        const json = text.length > 0 ? (JSON.parse(text) as unknown) : null;
        return { status: response.status, ok: response.ok, json };
      },
      catch: (cause) => githubAppError("githubApiRequest", "GitHub API request failed.", cause),
    });

  const getInstallationToken = (input: {
    appId: string;
    privateKeyPem: string;
    installationId: number;
  }) =>
    Effect.gen(function* () {
      const jwt = yield* createAppJwt(input.appId, input.privateKeyPem);
      const response = yield* githubApiRequest({
        method: "POST",
        path: `/app/installations/${input.installationId}/access_tokens`,
        token: jwt,
        body: {},
      });
      if (!response.ok || !response.json || typeof response.json !== "object") {
        return yield* Effect.fail(
          githubAppError(
            "getInstallationToken",
            `Installation token request failed with status ${response.status}.`,
          ),
        );
      }
      const token = toNonEmptyString((response.json as Record<string, unknown>).token);
      if (!token) {
        return yield* Effect.fail(
          githubAppError("getInstallationToken", "Installation token missing in response."),
        );
      }
      return token;
    });

  const postIssueComment = (input: {
    installationToken: string;
    repo: ParsedRepo;
    issueNumber: number;
    body: string;
  }) =>
    githubApiRequest({
      method: "POST",
      path: `/repos/${encodeURIComponent(input.repo.owner)}/${encodeURIComponent(input.repo.name)}/issues/${input.issueNumber}/comments`,
      token: input.installationToken,
      body: { body: input.body },
    }).pipe(Effect.ignore({ log: true }));

  const getInstallationTokenForConfiguredApp = (installationId: number) =>
    Effect.gen(function* () {
      const settings = yield* serverSettings.getSettings;
      const appId = settings.githubApp.appId.trim();
      if (appId.length === 0) {
        return null;
      }
      const secrets = yield* readStoredSecrets();
      const privateKeyPem = secrets.privateKeyPem?.trim() ?? "";
      if (privateKeyPem.length === 0) {
        return null;
      }
      return yield* getInstallationToken({
        appId,
        privateKeyPem: secrets.privateKeyPem!,
        installationId,
      }).pipe(Effect.catch(() => Effect.succeed(null)));
    });

  const postIssueCommentForInstallation = (input: {
    installationId: number;
    repo: ParsedRepo;
    issueNumber: number;
    body: string;
  }) =>
    Effect.gen(function* () {
      const installationToken = yield* getInstallationTokenForConfiguredApp(input.installationId);
      if (!installationToken) {
        return;
      }
      yield* postIssueComment({
        installationToken,
        repo: input.repo,
        issueNumber: input.issueNumber,
        body: input.body,
      });
    }).pipe(Effect.ignore({ log: true }));

  const checkCollaborator = (input: {
    installationToken: string;
    repo: ParsedRepo;
    username: string;
  }) =>
    Effect.gen(function* () {
      const response = yield* githubApiRequest({
        method: "GET",
        path: `/repos/${encodeURIComponent(input.repo.owner)}/${encodeURIComponent(input.repo.name)}/collaborators/${encodeURIComponent(input.username)}/permission`,
        token: input.installationToken,
      });
      if (response.status === 404) {
        return false;
      }
      if (!response.ok || !response.json || typeof response.json !== "object") {
        return false;
      }
      const permission = toNonEmptyString((response.json as Record<string, unknown>).permission);
      return permission !== null && permission !== "none";
    });

  const resolveCodexModelSelection = () =>
    Effect.gen(function* () {
      const settings = yield* serverSettings.getSettings;
      if (!settings.providers.codex.enabled) {
        return yield* Effect.fail(
          githubAppError("resolveCodexModelSelection", "Codex provider is disabled in settings."),
        );
      }
      const providers = yield* providerRegistry.getProviders;
      const codex = providers.find((provider) => provider.provider === "codex");
      if (!codex || !codex.enabled || !codex.installed || codex.status !== "ready") {
        return yield* Effect.fail(
          githubAppError("resolveCodexModelSelection", "Codex provider is not available."),
        );
      }
      return {
        provider: "codex",
        model: DEFAULT_MODEL_BY_PROVIDER.codex,
      } satisfies ModelSelection;
    });

  const resolveProjectByRepo = (repo: ParsedRepo) =>
    Effect.gen(function* () {
      const snapshot = yield* projectionSnapshotQuery.getSnapshot();
      const projects = snapshot.projects.filter((project) => project.deletedAt === null);
      for (const project of projects) {
        const remoteUrl = yield* gitCore
          .readConfigValue(project.workspaceRoot, "remote.origin.url")
          .pipe(Effect.catch(() => Effect.succeed(null)));
        const parsed = parseRepoFromRemoteUrl(remoteUrl);
        if (!parsed) continue;
        if (
          parsed.owner.toLowerCase() === repo.owner.toLowerCase() &&
          parsed.name.toLowerCase() === repo.name.toLowerCase()
        ) {
          return { project, snapshot };
        }
      }
      return null;
    });

  const prepareIssueWorktree = (workspaceRoot: string, issueNumber: number) =>
    Effect.gen(function* () {
      const list = yield* gitCore.listBranches({ cwd: workspaceRoot });
      const defaultBranch =
        list.branches.find((branch) => branch.isDefault)?.name ??
        list.branches.find((branch) => !branch.isRemote && branch.current)?.name ??
        list.branches.find((branch) => !branch.isRemote)?.name ??
        null;
      if (!defaultBranch) {
        return yield* Effect.fail(
          githubAppError("prepareIssueWorktree", "Unable to resolve default branch."),
        );
      }
      const localNames = yield* gitCore.listLocalBranchNames(workspaceRoot);
      const base = `t3code/issue-${issueNumber}`;
      let candidate = base;
      let suffix = 1;
      while (localNames.includes(candidate)) {
        candidate = `${base}-${suffix}`;
        suffix += 1;
      }
      const worktree = yield* gitCore.createWorktree({
        cwd: workspaceRoot,
        branch: defaultBranch,
        newBranch: candidate,
        path: null,
      });
      return {
        branch: worktree.worktree.branch,
        worktreePath: worktree.worktree.path,
      };
    });

  const processCleanupJobs = (): Effect.Effect<void, never> =>
    Effect.gen(function* () {
      const now = new Date().toISOString();
      const jobs = yield* cleanupJobs
        .listDuePending({ now, limit: 10 })
        .pipe(Effect.catch((_) => Effect.succeed([])));
      if (jobs.length === 0) {
        return;
      }
      const snapshot = yield* projectionSnapshotQuery.getSnapshot().pipe(
        Effect.catch((_) =>
          Effect.succeed({
            projects: [],
            threads: [],
          } as const),
        ),
      );

      for (const job of jobs) {
        const project = snapshot.projects.find((candidate) => candidate.id === job.projectId);
        const removeExit = yield* Effect.exit(
          project
            ? gitCore.removeWorktree({
                cwd: project.workspaceRoot,
                path: job.worktreePath,
                force: true,
              })
            : Effect.fail(new Error("project not found for cleanup job")),
        );
        if (removeExit._tag === "Success") {
          const completedAt = new Date().toISOString();
          yield* cleanupJobs
            .markSucceeded({ id: job.id, completedAt, updatedAt: completedAt })
            .pipe(Effect.ignore({ log: true }));
          const issueNumber = job.prNumber ?? job.issueNumber;
          if (issueNumber) {
            yield* postIssueCommentForInstallation({
              installationId: job.installationId,
              repo: { owner: job.repoOwner, name: job.repoName },
              issueNumber,
              body: `Worktree cleanup succeeded for thread \`${job.threadId}\` (\`${job.worktreePath}\`).`,
            });
          }
          continue;
        }

        const attemptCount = job.attemptCount + 1;
        const errorText = trimErrorMessage(removeExit.cause);
        if (attemptCount >= CLEANUP_MAX_ATTEMPTS) {
          const completedAt = new Date().toISOString();
          yield* cleanupJobs
            .markFailed({
              id: job.id,
              attemptCount,
              lastError: errorText,
              completedAt,
              updatedAt: completedAt,
            })
            .pipe(Effect.ignore({ log: true }));
          const issueNumber = job.prNumber ?? job.issueNumber;
          if (issueNumber) {
            yield* postIssueCommentForInstallation({
              installationId: job.installationId,
              repo: { owner: job.repoOwner, name: job.repoName },
              issueNumber,
              body: `Worktree cleanup failed after ${attemptCount} attempts for thread \`${job.threadId}\`. Delete manually: \`${job.worktreePath}\`.`,
            });
          }
          continue;
        }

        const backoffMs =
          CLEANUP_RETRY_BACKOFF_MS[
            Math.min(attemptCount - 1, CLEANUP_RETRY_BACKOFF_MS.length - 1)
          ] ?? 60_000;
        const updatedAt = new Date().toISOString();
        yield* cleanupJobs
          .markRetry({
            id: job.id,
            attemptCount,
            nextAttemptAt: new Date(Date.now() + backoffMs).toISOString(),
            lastError: errorText,
            updatedAt,
          })
          .pipe(Effect.ignore({ log: true }));
      }
    });

  const start: GithubAppAutomationShape["start"] = Effect.gen(function* () {
    const alreadyStarted = yield* Ref.get(startedRef);
    if (alreadyStarted) {
      return;
    }
    yield* Ref.set(startedRef, true);
    const loop = Effect.gen(function* () {
      while (true) {
        yield* processCleanupJobs();
        yield* Effect.sleep(Duration.seconds(20));
      }
    });
    yield* Effect.forkScoped(loop);
  });

  const runStartFlow = (context: StartContext) =>
    Effect.gen(function* () {
      const settings = yield* serverSettings.getSettings;
      const appId = settings.githubApp.appId.trim();
      const botLogin = settings.githubApp.botLogin.trim();
      const secrets = yield* readStoredSecrets();
      if (appId.length === 0 || botLogin.length === 0 || !secrets.privateKeyPem) {
        return { statusCode: 202, body: "github app metadata or private key missing" };
      }

      const installationToken = yield* getInstallationToken({
        appId,
        privateKeyPem: secrets.privateKeyPem,
        installationId: context.installationId,
      });

      const collaborator = yield* checkCollaborator({
        installationToken,
        repo: context.repo,
        username: context.senderLogin,
      });
      if (!collaborator) {
        yield* postIssueComment({
          installationToken,
          repo: context.repo,
          issueNumber: context.issueNumberForComment,
          body: `@${context.senderLogin} is not a repository collaborator, so this request was ignored.`,
        });
        return { statusCode: 200, body: "ignored non collaborator" };
      }

      const projectMatch = yield* resolveProjectByRepo(context.repo);
      if (!projectMatch) {
        yield* postIssueComment({
          installationToken,
          repo: context.repo,
          issueNumber: context.issueNumberForComment,
          body: `No local project maps to ${context.repo.owner}/${context.repo.name} by \`origin\` remote URL.`,
        });
        return { statusCode: 200, body: "project mapping not found" };
      }

      return yield* Effect.gen(function* () {
        const modelSelection = yield* resolveCodexModelSelection();
        const now = new Date().toISOString();
        const existingLink = yield* taskLinks.findActiveBySource({
          repoOwner: context.repo.owner,
          repoName: context.repo.name,
          sourceType: context.sourceType,
          sourceNumber: context.sourceNumber,
        });

        let threadId: ThreadId;
        if (existingLink._tag === "Some") {
          const activeThread = projectMatch.snapshot.threads.find(
            (thread) =>
              thread.id === existingLink.value.threadId &&
              thread.archivedAt === null &&
              thread.deletedAt === null,
          );
          if (activeThread) {
            threadId = existingLink.value.threadId;
          } else {
            yield* taskLinks
              .archiveLink({ id: existingLink.value.id, archivedAt: now, updatedAt: now })
              .pipe(Effect.ignore({ log: true }));
            threadId = ThreadId.makeUnsafe(randomUUID());
          }
        } else {
          threadId = ThreadId.makeUnsafe(randomUUID());
        }

        const shouldCreateThread =
          existingLink._tag === "None" ||
          !projectMatch.snapshot.threads.some(
            (thread) =>
              thread.id === threadId && thread.archivedAt === null && thread.deletedAt === null,
          );

        if (shouldCreateThread) {
          const prepared =
            context.sourceType === "pr"
              ? yield* gitManager.preparePullRequestThread({
                  cwd: projectMatch.project.workspaceRoot,
                  reference: `#${context.sourceNumber}`,
                  mode: "worktree",
                })
              : yield* prepareIssueWorktree(
                  projectMatch.project.workspaceRoot,
                  context.sourceNumber,
                );

          yield* orchestrationEngine.dispatch({
            type: "thread.create",
            commandId: CommandId.makeUnsafe(randomUUID()),
            threadId,
            projectId: projectMatch.project.id,
            title:
              `${context.sourceType === "pr" ? "PR" : "Issue"} #${context.sourceNumber}: ${context.title}`.slice(
                0,
                200,
              ),
            modelSelection,
            runtimeMode: "full-access",
            interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
            branch: prepared.branch,
            worktreePath: prepared.worktreePath,
            createdAt: now,
          });

          yield* taskLinks.insert({
            repoOwner: context.repo.owner,
            repoName: context.repo.name,
            sourceType: context.sourceType,
            sourceNumber: context.sourceNumber,
            prNumber: context.prNumber,
            sourceBranch: prepared.branch,
            threadId,
            projectId: projectMatch.project.id,
            createdAt: now,
            updatedAt: now,
          });
        }

        yield* orchestrationEngine.dispatch({
          type: "thread.turn.start",
          commandId: CommandId.makeUnsafe(randomUUID()),
          threadId,
          message: {
            messageId: MessageId.makeUnsafe(randomUUID()),
            role: "user",
            text: buildStartMessage({
              repo: context.repo,
              sourceType: context.sourceType,
              sourceNumber: context.sourceNumber,
              title: context.title,
              body: context.body,
              commentBody: context.commentBody,
              commandSuffix: context.commandSuffix,
            }),
            attachments: [],
          },
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          createdAt: new Date().toISOString(),
        });

        yield* postIssueComment({
          installationToken,
          repo: context.repo,
          issueNumber: context.issueNumberForComment,
          body: `Task started in thread \`${threadId}\`.`,
        });

        return { statusCode: 200, body: `started thread ${threadId}` };
      }).pipe(
        Effect.catch((error) =>
          Effect.gen(function* () {
            yield* postIssueComment({
              installationToken,
              repo: context.repo,
              issueNumber: context.issueNumberForComment,
              body: `Task start failed: ${trimErrorMessage(error)}`,
            });
            return {
              statusCode: 200,
              body: `start failed: ${trimErrorMessage(error)}`,
            } satisfies GithubWebhookResponse;
          }),
        ),
      );
    });

  const runPullRequestOpenedFlow = (payload: Record<string, unknown>) =>
    Effect.gen(function* () {
      const action = toNonEmptyString(payload.action);
      if (action !== "opened") {
        return {
          statusCode: 200,
          body: "ignored pull_request action",
        } satisfies GithubWebhookResponse;
      }
      const repository = payload.repository as Record<string, unknown> | undefined;
      const pullRequest = payload.pull_request as Record<string, unknown> | undefined;
      const repoOwner = toNonEmptyString(
        (repository?.owner as Record<string, unknown> | undefined)?.login,
      );
      const repoName = toNonEmptyString(repository?.name);
      const prNumber = toPositiveInt(pullRequest?.number);
      const headRef = toNonEmptyString(
        (pullRequest?.head as Record<string, unknown> | undefined)?.ref,
      );
      if (!repoOwner || !repoName || !prNumber || !headRef) {
        return {
          statusCode: 200,
          body: "ignored malformed pull_request.opened payload",
        } satisfies GithubWebhookResponse;
      }

      const candidates = yield* taskLinks.listActiveIssueLinksWithoutPr({
        repoOwner,
        repoName,
      });
      if (candidates.length === 0) {
        return {
          statusCode: 200,
          body: "no issue links awaiting pr",
        } satisfies GithubWebhookResponse;
      }
      const snapshot = yield* projectionSnapshotQuery.getSnapshot();
      const match = candidates.find((link) => {
        const thread = snapshot.threads.find(
          (candidate) =>
            candidate.id === link.threadId &&
            candidate.archivedAt === null &&
            candidate.deletedAt === null,
        );
        return thread?.branch === headRef || link.sourceBranch === headRef;
      });
      if (!match) {
        return {
          statusCode: 200,
          body: "no branch-matched issue link",
        } satisfies GithubWebhookResponse;
      }
      yield* taskLinks.attachPrToLink({
        id: match.id,
        prNumber,
        updatedAt: new Date().toISOString(),
      });
      return {
        statusCode: 200,
        body: "linked issue thread to opened pr",
      } satisfies GithubWebhookResponse;
    });

  const runPullRequestMergedFlow = (payload: Record<string, unknown>) =>
    Effect.gen(function* () {
      const action = toNonEmptyString(payload.action);
      const pullRequest = payload.pull_request as Record<string, unknown> | undefined;
      if (action !== "closed" || pullRequest?.merged !== true) {
        return {
          statusCode: 200,
          body: "ignored pull_request action",
        } satisfies GithubWebhookResponse;
      }
      const installationId = toPositiveInt(
        (payload.installation as Record<string, unknown> | undefined)?.id,
      );
      const repository = payload.repository as Record<string, unknown> | undefined;
      const repoOwner = toNonEmptyString(
        (repository?.owner as Record<string, unknown> | undefined)?.login,
      );
      const repoName = toNonEmptyString(repository?.name);
      const prNumber = toPositiveInt(pullRequest?.number);
      if (!installationId || !repoOwner || !repoName || !prNumber) {
        return {
          statusCode: 200,
          body: "ignored malformed pull_request.closed payload",
        } satisfies GithubWebhookResponse;
      }

      const links = yield* taskLinks.listActiveByPr({
        repoOwner,
        repoName,
        prNumber,
      });
      if (links.length === 0) {
        return {
          statusCode: 200,
          body: "no active linked threads for merged pr",
        } satisfies GithubWebhookResponse;
      }

      const snapshot = yield* projectionSnapshotQuery.getSnapshot();
      const now = new Date().toISOString();
      let archivedCount = 0;
      let queuedCleanupCount = 0;
      for (const link of links) {
        const thread = snapshot.threads.find((candidate) => candidate.id === link.threadId);
        yield* orchestrationEngine
          .dispatch({
            type: "thread.session.stop",
            commandId: CommandId.makeUnsafe(randomUUID()),
            threadId: link.threadId,
            createdAt: now,
          })
          .pipe(Effect.ignore({ log: true }));
        yield* orchestrationEngine
          .dispatch({
            type: "thread.archive",
            commandId: CommandId.makeUnsafe(randomUUID()),
            threadId: link.threadId,
          })
          .pipe(Effect.ignore({ log: true }));
        yield* orchestrationEngine
          .dispatch({
            type: "thread.meta.update",
            commandId: CommandId.makeUnsafe(randomUUID()),
            threadId: link.threadId,
            branch: null,
            worktreePath: null,
          })
          .pipe(Effect.ignore({ log: true }));
        if (thread?.worktreePath) {
          yield* cleanupJobs.enqueue({
            worktreePath: thread.worktreePath,
            projectId: link.projectId,
            threadId: link.threadId,
            repoOwner,
            repoName,
            prNumber,
            issueNumber: prNumber,
            installationId,
            nextAttemptAt: now,
            createdAt: now,
            updatedAt: now,
          });
          queuedCleanupCount += 1;
        }
        yield* taskLinks.archiveLink({
          id: link.id,
          archivedAt: now,
          updatedAt: now,
        });
        archivedCount += 1;
      }

      yield* postIssueCommentForInstallation({
        installationId,
        repo: { owner: repoOwner, name: repoName },
        issueNumber: prNumber,
        body:
          queuedCleanupCount > 0
            ? `Merged PR #${prNumber}: archived ${archivedCount} linked thread(s) and queued ${queuedCleanupCount} worktree cleanup job(s).`
            : `Merged PR #${prNumber}: archived ${archivedCount} linked thread(s). No worktree paths were available for deletion.`,
      });

      return { statusCode: 200, body: "merged pr cleanup queued" } satisfies GithubWebhookResponse;
    });

  const handleWebhookInternal = (request: GithubWebhookRequest) =>
    Effect.gen(function* () {
      const settings = yield* serverSettings.getSettings;
      if (!settings.githubApp.enabled) {
        return { statusCode: 202, body: "github app integration disabled" };
      }
      const appId = settings.githubApp.appId.trim();
      const botLogin = settings.githubApp.botLogin.trim();
      if (appId.length === 0 || botLogin.length === 0) {
        return { statusCode: 202, body: "github app metadata incomplete" };
      }

      const deliveryId = headerToString(request.headers["x-github-delivery"]);
      const eventName = headerToString(request.headers["x-github-event"]);
      const signature = headerToString(request.headers["x-hub-signature-256"]);
      if (!deliveryId || !eventName) {
        return { statusCode: 400, body: "missing github delivery headers" };
      }

      const secrets = yield* readStoredSecrets();
      const webhookSecret = secrets.webhookSecret?.trim() ?? "";
      if (webhookSecret.length === 0) {
        return { statusCode: 503, body: "webhook secret not configured" };
      }
      if (!signature) {
        return { statusCode: 401, body: "missing webhook signature" };
      }
      const expected = `sha256=${createHmac("sha256", webhookSecret).update(request.rawBody).digest("hex")}`;
      const providedBytes = Buffer.from(signature, "utf8");
      const expectedBytes = Buffer.from(expected, "utf8");
      if (
        providedBytes.length !== expectedBytes.length ||
        !timingSafeEqual(providedBytes, expectedBytes)
      ) {
        return { statusCode: 401, body: "invalid webhook signature" };
      }

      const inserted = yield* webhookDeliveries.tryInsert({
        deliveryId,
        eventName,
        receivedAt: new Date().toISOString(),
      });
      if (!inserted) {
        return { statusCode: 200, body: "duplicate delivery ignored" };
      }

      const payload = yield* Effect.try({
        try: () =>
          JSON.parse(Buffer.from(request.rawBody).toString("utf8")) as Record<string, unknown>,
        catch: (cause) =>
          githubAppError("handleWebhook", "Webhook payload is not valid JSON.", cause),
      });

      if (eventName === "issue_comment") {
        const action = toNonEmptyString(payload.action);
        if (action !== "created") {
          return { statusCode: 200, body: "ignored issue_comment action" };
        }
        const repository = payload.repository as Record<string, unknown> | undefined;
        const issue = payload.issue as Record<string, unknown> | undefined;
        const comment = payload.comment as Record<string, unknown> | undefined;
        const sender = payload.sender as Record<string, unknown> | undefined;
        const installation = payload.installation as Record<string, unknown> | undefined;
        const repoOwner = toNonEmptyString(
          (repository?.owner as Record<string, unknown> | undefined)?.login,
        );
        const repoName = toNonEmptyString(repository?.name);
        const issueNumber = toPositiveInt(issue?.number);
        const senderLogin = toNonEmptyString(sender?.login);
        const installationId = toPositiveInt(installation?.id);
        const commentBody = typeof comment?.body === "string" ? comment.body : "";
        if (!repoOwner || !repoName || !issueNumber || !senderLogin || !installationId) {
          return { statusCode: 200, body: "ignored malformed issue_comment payload" };
        }
        if (!hasStartTrigger(commentBody, botLogin)) {
          return { statusCode: 200, body: "ignored comment without trigger" };
        }
        const isPrComment = Boolean(issue?.pull_request);
        return yield* runStartFlow({
          installationId,
          repo: { owner: repoOwner, name: repoName },
          sourceType: isPrComment ? "pr" : "issue",
          sourceNumber: issueNumber,
          prNumber: isPrComment ? issueNumber : null,
          issueNumberForComment: issueNumber,
          senderLogin,
          title: toNonEmptyString(issue?.title) ?? `Issue #${issueNumber}`,
          body: typeof issue?.body === "string" ? issue.body : "",
          commentBody,
          commandSuffix: extractStartSuffix(commentBody),
        });
      }

      if (eventName === "pull_request_review_comment") {
        const action = toNonEmptyString(payload.action);
        if (action !== "created") {
          return { statusCode: 200, body: "ignored pull_request_review_comment action" };
        }
        const repository = payload.repository as Record<string, unknown> | undefined;
        const pullRequest = payload.pull_request as Record<string, unknown> | undefined;
        const comment = payload.comment as Record<string, unknown> | undefined;
        const sender = payload.sender as Record<string, unknown> | undefined;
        const installation = payload.installation as Record<string, unknown> | undefined;
        const repoOwner = toNonEmptyString(
          (repository?.owner as Record<string, unknown> | undefined)?.login,
        );
        const repoName = toNonEmptyString(repository?.name);
        const prNumber = toPositiveInt(pullRequest?.number);
        const senderLogin = toNonEmptyString(sender?.login);
        const installationId = toPositiveInt(installation?.id);
        const commentBody = typeof comment?.body === "string" ? comment.body : "";
        if (!repoOwner || !repoName || !prNumber || !senderLogin || !installationId) {
          return { statusCode: 200, body: "ignored malformed pull_request_review_comment payload" };
        }
        if (!hasStartTrigger(commentBody, botLogin)) {
          return { statusCode: 200, body: "ignored review comment without trigger" };
        }
        return yield* runStartFlow({
          installationId,
          repo: { owner: repoOwner, name: repoName },
          sourceType: "pr",
          sourceNumber: prNumber,
          prNumber,
          issueNumberForComment: prNumber,
          senderLogin,
          title: toNonEmptyString(pullRequest?.title) ?? `PR #${prNumber}`,
          body: typeof pullRequest?.body === "string" ? pullRequest.body : "",
          commentBody,
          commandSuffix: extractStartSuffix(commentBody),
        });
      }

      if (eventName === "pull_request") {
        const action = toNonEmptyString(payload.action);
        if (action === "opened") {
          return yield* runPullRequestOpenedFlow(payload);
        }
        if (action === "closed") {
          return yield* runPullRequestMergedFlow(payload);
        }
        return { statusCode: 200, body: "ignored pull_request action" };
      }

      return { statusCode: 200, body: "ignored event" };
    });

  const handleWebhook: GithubAppAutomationShape["handleWebhook"] = (request) =>
    handleWebhookInternal(request).pipe(
      Effect.catch((error) =>
        Effect.succeed({
          statusCode: 500,
          body: trimErrorMessage(error),
        }),
      ),
    );

  return {
    start,
    getSecretsStatus,
    updateSecrets,
    handleWebhook,
  } satisfies GithubAppAutomationShape;
});

export const GithubAppAutomationLive = Layer.effect(GithubAppAutomation, makeGithubAppAutomation);
