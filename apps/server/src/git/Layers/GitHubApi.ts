/**
 * GitHubApi - GitHubCli layer implementation backed by the GitHub REST API
 * using GitHub App installation tokens.
 *
 * Replaces the `gh` CLI dependency for PR operations, repo metadata, etc.
 *
 * @module GitHubApi
 */
import { Effect, FileSystem, Layer, Path } from "effect";

import { ServerConfig } from "../../config.ts";
import {
  type GitHubApiError,
  getInstallationIdForRepo,
  getInstallationToken,
  githubApiRequest,
  parseRepoFromRemoteUrl,
} from "../../github/githubApi.ts";
import { runProcess } from "../../processRunner.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { GitHubCliError } from "../Errors.ts";
import {
  GitHubCli,
  type GitHubCliShape,
  type GitHubPullRequestSummary,
  type GitHubRepositoryCloneUrls,
} from "../Services/GitHubCli.ts";

const apiError = (operation: string, detail: string, cause?: unknown) =>
  new GitHubCliError({ operation, detail, ...(cause !== undefined ? { cause } : {}) });

const makeGitHubApi = Effect.gen(function* () {
  const serverSettings = yield* ServerSettingsService;
  const serverConfig = yield* ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const pathService = yield* Path.Path;

  const secretsPath = pathService.join(serverConfig.stateDir, "github-app-secrets.json");

  const readPrivateKey = (): Effect.Effect<string, GitHubCliError> =>
    Effect.gen(function* () {
      const exists = yield* fs.exists(secretsPath).pipe(
        Effect.mapError((cause) => apiError("readPrivateKey", "Failed to check secrets file.", cause)),
      );
      if (!exists) {
        return yield* apiError("readPrivateKey", "GitHub App private key not configured. Set it in Settings > GitHub App.");
      }
      const raw = yield* fs.readFileString(secretsPath).pipe(
        Effect.mapError((cause) => apiError("readPrivateKey", "Failed to read secrets file.", cause)),
      );
      const parsed = JSON.parse(raw) as { privateKeyPem?: string };
      const pem = parsed.privateKeyPem?.trim() ?? "";
      if (pem.length === 0) {
        return yield* apiError("readPrivateKey", "GitHub App private key is empty. Set it in Settings > GitHub App.");
      }
      return pem;
    });

  const getRepoContext = (cwd: string) =>
    Effect.gen(function* () {
      const result = yield* Effect.tryPromise({
        try: () => runProcess("git", ["remote", "get-url", "origin"], { cwd, timeoutMs: 5_000 }),
        catch: (cause) => apiError("getRepoContext", "Failed to read git remote URL.", cause),
      });
      const parsed = parseRepoFromRemoteUrl(result.stdout.trim());
      if (!parsed) {
        return yield* apiError("getRepoContext", "Could not parse GitHub owner/repo from origin remote URL.");
      }
      return parsed;
    });

  const getToken = (cwd: string): Effect.Effect<{ token: string; owner: string; name: string }, GitHubCliError> =>
    Effect.gen(function* () {
      const settings = yield* serverSettings.getSettings.pipe(
        Effect.mapError((cause) => apiError("getToken", "Failed to read server settings.", cause)),
      );
      const appId = settings.githubApp.appId.trim();
      if (appId.length === 0) {
        return yield* apiError("getToken", "GitHub App ID is not configured. Set it in Settings > GitHub App.");
      }
      const privateKeyPem = yield* readPrivateKey();
      const repo = yield* getRepoContext(cwd);
      const installationId = yield* getInstallationIdForRepo({
        appId,
        privateKeyPem,
        owner: repo.owner,
        repo: repo.name,
      }).pipe(Effect.mapError((cause) => apiError("getToken", `Failed to get installation: ${cause.message}`, cause)));
      const token = yield* getInstallationToken({
        appId,
        privateKeyPem,
        installationId,
      }).pipe(Effect.mapError((cause) => apiError("getToken", `Failed to get installation token: ${cause.message}`, cause)));
      return { token, owner: repo.owner, name: repo.name };
    });

  const execute: GitHubCliShape["execute"] = () =>
    apiError("execute", "Raw execute is not supported in GitHub API mode.");

  const listOpenPullRequests: GitHubCliShape["listOpenPullRequests"] = (input) =>
    Effect.gen(function* () {
      const { token, owner, name } = yield* getToken(input.cwd);
      const limit = input.limit ?? 1;

      // GitHub API: head filter format is "owner:branch" for same-repo
      const headFilter = input.headSelector.includes(":")
        ? input.headSelector
        : `${owner}:${input.headSelector}`;

      const response = yield* githubApiRequest({
        method: "GET",
        path: `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/pulls?state=open&head=${encodeURIComponent(headFilter)}&per_page=${limit}`,
        token,
      }).pipe(Effect.mapError((cause) => apiError("listOpenPullRequests", cause.message, cause)));

      if (!response.ok || !Array.isArray(response.json)) {
        return [];
      }

      return (response.json as Array<Record<string, unknown>>).map(
        (pr): GitHubPullRequestSummary => ({
          number: pr.number as number,
          title: (pr.title as string) ?? "",
          url: (pr.html_url as string) ?? "",
          baseRefName: ((pr.base as Record<string, unknown>)?.ref as string) ?? "",
          headRefName: ((pr.head as Record<string, unknown>)?.ref as string) ?? "",
        }),
      );
    });

  const getPullRequest: GitHubCliShape["getPullRequest"] = (input) =>
    Effect.gen(function* () {
      const { token, owner, name } = yield* getToken(input.cwd);

      // Reference can be a number, #number, or URL
      let prNumber: string;
      const numMatch = /^#?(\d+)$/.exec(input.reference.trim());
      if (numMatch) {
        prNumber = numMatch[1]!;
      } else {
        const urlMatch = /\/pull\/(\d+)/.exec(input.reference);
        if (urlMatch) {
          prNumber = urlMatch[1]!;
        } else {
          // Try as branch name - list PRs for this head
          const prs = yield* listOpenPullRequests({
            cwd: input.cwd,
            headSelector: input.reference,
            limit: 1,
          });
          if (prs.length === 0) {
            return yield* apiError("getPullRequest", `Pull request not found for reference: ${input.reference}`);
          }
          return prs[0]!;
        }
      }

      const response = yield* githubApiRequest({
        method: "GET",
        path: `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/pulls/${prNumber}`,
        token,
      }).pipe(Effect.mapError((cause) => apiError("getPullRequest", cause.message, cause)));

      if (!response.ok || !response.json || typeof response.json !== "object") {
        return yield* apiError("getPullRequest", `Pull request #${prNumber} not found (status ${response.status}).`);
      }

      const pr = response.json as Record<string, unknown>;
      const head = pr.head as Record<string, unknown>;
      const base = pr.base as Record<string, unknown>;
      const headRepo = head?.repo as Record<string, unknown> | null;
      const baseRepo = base?.repo as Record<string, unknown> | null;

      const headRepoFullName = headRepo?.full_name as string | null;
      const baseRepoFullName = baseRepo?.full_name as string | null;
      const isCrossRepository =
        headRepoFullName !== null &&
        baseRepoFullName !== null &&
        headRepoFullName !== baseRepoFullName;

      const state = pr.merged === true ? "merged" : pr.state === "closed" ? "closed" : "open";

      return {
        number: pr.number as number,
        title: (pr.title as string) ?? "",
        url: (pr.html_url as string) ?? "",
        baseRefName: (base?.ref as string) ?? "",
        headRefName: (head?.ref as string) ?? "",
        state,
        isCrossRepository,
        headRepositoryNameWithOwner: headRepoFullName ?? null,
        headRepositoryOwnerLogin: headRepo?.owner
          ? ((headRepo.owner as Record<string, unknown>).login as string) ?? null
          : null,
      } satisfies GitHubPullRequestSummary;
    });

  const getRepositoryCloneUrls: GitHubCliShape["getRepositoryCloneUrls"] = (input) =>
    Effect.gen(function* () {
      const { token } = yield* getToken(input.cwd);

      const response = yield* githubApiRequest({
        method: "GET",
        path: `/repos/${input.repository}`,
        token,
      }).pipe(Effect.mapError((cause) => apiError("getRepositoryCloneUrls", cause.message, cause)));

      if (!response.ok || !response.json || typeof response.json !== "object") {
        return yield* apiError("getRepositoryCloneUrls", `Repository ${input.repository} not found (status ${response.status}).`);
      }

      const repo = response.json as Record<string, unknown>;
      return {
        nameWithOwner: (repo.full_name as string) ?? "",
        url: (repo.html_url as string) ?? "",
        sshUrl: (repo.ssh_url as string) ?? "",
      } satisfies GitHubRepositoryCloneUrls;
    });

  const createPullRequest: GitHubCliShape["createPullRequest"] = (input) =>
    Effect.gen(function* () {
      const { token, owner, name } = yield* getToken(input.cwd);

      // Read body from file
      const body = yield* fs.readFileString(input.bodyFile).pipe(
        Effect.mapError((cause) => apiError("createPullRequest", "Failed to read PR body file.", cause)),
      );

      // headSelector may be "owner:branch" for cross-repo PRs
      const head = input.headSelector;

      const response = yield* githubApiRequest({
        method: "POST",
        path: `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/pulls`,
        token,
        body: {
          title: input.title,
          body,
          head,
          base: input.baseBranch,
        },
      }).pipe(Effect.mapError((cause) => apiError("createPullRequest", cause.message, cause)));

      if (!response.ok) {
        const errorBody =
          response.json && typeof response.json === "object"
            ? ((response.json as Record<string, unknown>).message as string) ?? ""
            : "";
        return yield* apiError(
          "createPullRequest",
          `Failed to create pull request (status ${response.status}): ${errorBody}`.trim(),
        );
      }
    });

  const getDefaultBranch: GitHubCliShape["getDefaultBranch"] = (input) =>
    Effect.gen(function* () {
      const { token, owner, name } = yield* getToken(input.cwd);

      const response = yield* githubApiRequest({
        method: "GET",
        path: `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`,
        token,
      }).pipe(Effect.mapError((cause) => apiError("getDefaultBranch", cause.message, cause)));

      if (!response.ok || !response.json || typeof response.json !== "object") {
        return null;
      }

      const defaultBranch = (response.json as Record<string, unknown>).default_branch;
      return typeof defaultBranch === "string" && defaultBranch.trim().length > 0
        ? defaultBranch.trim()
        : null;
    });

  const checkoutPullRequest: GitHubCliShape["checkoutPullRequest"] = (input) =>
    Effect.gen(function* () {
      const { token, owner, name } = yield* getToken(input.cwd);

      // Get PR details to know the head branch
      const prResponse = yield* githubApiRequest({
        method: "GET",
        path: `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/pulls/${input.reference.replace(/^#/, "")}`,
        token,
      }).pipe(Effect.mapError((cause) => apiError("checkoutPullRequest", cause.message, cause)));

      if (!prResponse.ok || !prResponse.json || typeof prResponse.json !== "object") {
        return yield* apiError("checkoutPullRequest", `Pull request ${input.reference} not found.`);
      }

      const pr = prResponse.json as Record<string, unknown>;
      const head = pr.head as Record<string, unknown>;
      const headRef = head?.ref as string;
      const prNumber = pr.number as number;

      // Fetch the PR head and create/update local branch
      const fetchArgs = [
        "fetch",
        "origin",
        `pull/${prNumber}/head:${headRef}`,
      ];
      yield* Effect.tryPromise({
        try: () => runProcess("git", fetchArgs, { cwd: input.cwd, timeoutMs: 30_000 }),
        catch: (cause) => apiError("checkoutPullRequest", `Failed to fetch PR head: ${cause}`, cause),
      });

      const checkoutArgs = input.force
        ? ["checkout", "--force", headRef]
        : ["checkout", headRef];
      yield* Effect.tryPromise({
        try: () => runProcess("git", checkoutArgs, { cwd: input.cwd, timeoutMs: 10_000 }),
        catch: (cause) => apiError("checkoutPullRequest", `Failed to checkout branch: ${cause}`, cause),
      });
    });

  return {
    execute,
    listOpenPullRequests,
    getPullRequest,
    getRepositoryCloneUrls,
    createPullRequest,
    getDefaultBranch,
    checkoutPullRequest,
  } satisfies GitHubCliShape;
});

export const GitHubApiLive = Layer.effect(GitHubCli, makeGitHubApi);
