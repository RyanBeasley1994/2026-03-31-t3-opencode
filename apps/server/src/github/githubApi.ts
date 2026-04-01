/**
 * Shared GitHub API helpers for GitHub App authentication and REST API calls.
 *
 * Used by both GithubAppAutomation (webhooks) and GitHubApi (replacing gh CLI).
 *
 * @module githubApi
 */
import { createSign } from "node:crypto";

import { Data, Effect } from "effect";

// ── Types ────────────────────────────────────────────────────────────

export class GitHubApiError extends Data.TaggedError("GitHubApiError")<{
  readonly detail: string;
  readonly cause?: unknown;
}> {
  override get message(): string {
    return this.detail;
  }
}

export interface GitHubApiResponse {
  readonly status: number;
  readonly ok: boolean;
  readonly json: unknown;
}

// ── JWT ──────────────────────────────────────────────────────────────

export const createAppJwt = (
  appId: string,
  privateKeyPem: string,
): Effect.Effect<string, GitHubApiError> =>
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
    catch: (cause) =>
      new GitHubApiError({ detail: `Failed to create GitHub app JWT: ${cause}`, cause }),
  });

// ── API request ──────────────────────────────────────────────────────

export const githubApiRequest = (input: {
  method: string;
  path: string;
  token: string;
  body?: unknown;
}): Effect.Effect<GitHubApiResponse, GitHubApiError> =>
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
    catch: (cause) => new GitHubApiError({ detail: `GitHub API request failed: ${cause}`, cause }),
  });

// ── Installation token ───────────────────────────────────────────────

export const getInstallationToken = (input: {
  appId: string;
  privateKeyPem: string;
  installationId: number;
}): Effect.Effect<string, GitHubApiError> =>
  Effect.gen(function* () {
    const jwt = yield* createAppJwt(input.appId, input.privateKeyPem);
    const response = yield* githubApiRequest({
      method: "POST",
      path: `/app/installations/${input.installationId}/access_tokens`,
      token: jwt,
      body: {},
    });
    if (!response.ok || !response.json || typeof response.json !== "object") {
      return yield* new GitHubApiError({
        detail: `Installation token request failed with status ${response.status}.`,
      });
    }
    const token = (response.json as Record<string, unknown>).token;
    if (typeof token !== "string" || token.trim().length === 0) {
      return yield* new GitHubApiError({ detail: "Installation token missing in response." });
    }
    return token;
  });

// ── Installation ID lookup ───────────────────────────────────────────

export const getInstallationIdForRepo = (input: {
  appId: string;
  privateKeyPem: string;
  owner: string;
  repo: string;
}): Effect.Effect<number, GitHubApiError> =>
  Effect.gen(function* () {
    const jwt = yield* createAppJwt(input.appId, input.privateKeyPem);
    const response = yield* githubApiRequest({
      method: "GET",
      path: `/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repo)}/installation`,
      token: jwt,
    });
    if (!response.ok || !response.json || typeof response.json !== "object") {
      return yield* new GitHubApiError({
        detail: `Failed to get installation for ${input.owner}/${input.repo} (status ${response.status}).`,
      });
    }
    const id = (response.json as Record<string, unknown>).id;
    if (typeof id !== "number" || !Number.isInteger(id) || id <= 0) {
      return yield* new GitHubApiError({
        detail: `Invalid installation ID in response for ${input.owner}/${input.repo}.`,
      });
    }
    return id;
  });

// ── Repo parsing ─────────────────────────────────────────────────────

export const parseRepoFromRemoteUrl = (
  url: string | null,
): { owner: string; name: string } | null => {
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

// ── Push credential env ──────────────────────────────────────────────

/**
 * Build env vars that inject a GitHub App installation token as HTTPS
 * credentials for `git push`.  Uses `url.<base>.insteadOf` to rewrite
 * `https://github.com/` URLs to include the token.
 */
export const buildPushCredentialEnv = (token: string): Record<string, string> => ({
  GIT_CONFIG_COUNT: "1",
  GIT_CONFIG_KEY_0: `url.https://x-access-token:${token}@github.com/.insteadOf`,
  GIT_CONFIG_VALUE_0: "https://github.com/",
  GIT_TERMINAL_PROMPT: "0",
});
