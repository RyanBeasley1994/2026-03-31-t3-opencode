import { IsoDateTime, TrimmedNonEmptyString } from "@t3tools/contracts";
import { Schema, ServiceMap } from "effect";
import type { Effect } from "effect";
import type { ProjectionRepositoryError } from "../Errors.ts";

export const GithubWebhookDeliveryInput = Schema.Struct({
  deliveryId: TrimmedNonEmptyString,
  eventName: TrimmedNonEmptyString,
  receivedAt: IsoDateTime,
});
export type GithubWebhookDeliveryInput = typeof GithubWebhookDeliveryInput.Type;

export interface GithubWebhookDeliveryRepositoryShape {
  readonly tryInsert: (
    input: GithubWebhookDeliveryInput,
  ) => Effect.Effect<boolean, ProjectionRepositoryError>;
}

export class GithubWebhookDeliveryRepository extends ServiceMap.Service<
  GithubWebhookDeliveryRepository,
  GithubWebhookDeliveryRepositoryShape
>()("t3/persistence/Services/GithubWebhookDeliveries/GithubWebhookDeliveryRepository") {}
