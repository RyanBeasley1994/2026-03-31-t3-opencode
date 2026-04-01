import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { toPersistenceSqlError } from "../Errors.ts";
import {
  GithubWebhookDeliveryRepository,
  type GithubWebhookDeliveryRepositoryShape,
} from "../Services/GithubWebhookDeliveries.ts";

const makeGithubWebhookDeliveryRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const tryInsert: GithubWebhookDeliveryRepositoryShape["tryInsert"] = (input) =>
    sql<{ readonly deliveryId: string }>`
      INSERT INTO github_webhook_deliveries (delivery_id, event_name, received_at)
      VALUES (${input.deliveryId}, ${input.eventName}, ${input.receivedAt})
      ON CONFLICT (delivery_id) DO NOTHING
      RETURNING delivery_id AS "deliveryId"
    `.pipe(
      Effect.map((rows) => rows.length > 0),
      Effect.mapError(toPersistenceSqlError("GithubWebhookDeliveryRepository.tryInsert:query")),
    );

  return {
    tryInsert,
  } satisfies GithubWebhookDeliveryRepositoryShape;
});

export const GithubWebhookDeliveryRepositoryLive = Layer.effect(
  GithubWebhookDeliveryRepository,
  makeGithubWebhookDeliveryRepository,
);
