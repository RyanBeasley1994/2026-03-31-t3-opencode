/**
 * Shared GitHub API helpers for GitHub App authentication and REST API calls.
 *
 * Used by both GithubAppAutomation (webhooks) and GitHubApi (replacing gh CLI).
 *
 * @module githubApi
 */
import { createSign } from "node:crypto";

import { Effect } from "effect";

// ── Types ────────────────────────────────────────────────────────────

export interface GitHubApiResponse {
  readonly status: number;
  readonly ok: boolean;
  readonly json: unknown;
}

// ── JWT ──────────────────────────────────────────────────────────────

export const createAppJwt = (appId: string, privateKeyPem: string): Effect.Effect<string, Error> =>
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
    catch: (cause) => new Error(`Failed to create GitHub app JWT: ${cause}`),
  });

// ── API request ──────────────────────────────────────────────────────

export const githubApiRequest = (input: {
  method: string;
  path: string;
  token: string;
  body?: unknown;
}): Effect.Effect<GitHubApiResponse, Error> =>
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
    catch: (cause) => new Error(`GitHub API request failed: ${cause}`),
  });

// ── Installation token ───────────────────────────────────────────────

export const getInstallationToken = (input: {
  appId: string;
  privateKeyPem: string;
  installationId: number;
}): Effect.Effect<string, Error> =>
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
        new Error(
          `Installation token request failed with status ${response.status}.`,
        ),
      );
    }
    const token = (response.json as Record<string, unknown>).token;
    if (typeof token !== "string" || token.trim().length === 0) {
      return yield* Effect.fail(new Error("Installation token missing in response."));
    }
    return token;
  });

// ── Installation ID lookup ───────────────────────────────────────────

export const getInstallationIdForRepo = (input: {
  appId: string;
  privateKeyPem: string;
  owner: string;
  repo: string;
}): Effect.Effect<number, Error> =>
  Effect.gen(function* () {
    const jwt = yield* createAppJwt(input.appId, input.privateKeyPem);
    const response = yield* githubApiRequest({
      method: "GET",
      path: `/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repo)}/installation`,
      token: jwt,
    });
    if (!response.ok || !response.json || typeof response.json !== "object") {
      return yield* Effect.fail(
        new Error(
          `Failed to get installation for ${input.owner}/${input.repo} (status ${response.status}).`,
        ),
      );
    }
    const id = (response.json as Record<string, unknown>).id;
    if (typeof id !== "number" || !Number.isInteger(id) || id <= 0) {
      return yield* Effect.fail(
        new Error(`Invalid installation ID in response for ${input.owner}/${input.repo}.`),
      );
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
