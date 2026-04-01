import type { IncomingHttpHeaders } from "node:http";

import { GithubAppSecretsStatus, GithubAppSecretsUpdate } from "@t3tools/contracts";
import { ServiceMap } from "effect";
import type { Effect, Scope } from "effect";

export class GithubAppAutomationError extends Error {
  readonly operation: string;
  override readonly cause?: unknown;

  constructor(input: { operation: string; detail: string; cause?: unknown }) {
    super(`GitHub app automation error in ${input.operation}: ${input.detail}`);
    this.name = "GithubAppAutomationError";
    this.operation = input.operation;
    this.cause = input.cause;
  }
}

export interface GithubWebhookResponse {
  readonly statusCode: number;
  readonly body: string;
}

export interface GithubWebhookRequest {
  readonly headers: IncomingHttpHeaders;
  readonly rawBody: Uint8Array;
}

export interface GithubAppAutomationShape {
  readonly start: Effect.Effect<void, never, Scope.Scope>;
  readonly getSecretsStatus: Effect.Effect<GithubAppSecretsStatus>;
  readonly updateSecrets: (patch: GithubAppSecretsUpdate) => Effect.Effect<GithubAppSecretsStatus>;
  readonly handleWebhook: (request: GithubWebhookRequest) => Effect.Effect<GithubWebhookResponse>;
}

export class GithubAppAutomation extends ServiceMap.Service<
  GithubAppAutomation,
  GithubAppAutomationShape
>()("t3/github/Services/GithubAppAutomation") {}
