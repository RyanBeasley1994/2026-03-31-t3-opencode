import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Effect from "effect/Effect";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    ALTER TABLE projection_threads
    ADD COLUMN assigned_user_id TEXT REFERENCES users(user_id) ON DELETE SET NULL
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_threads_assigned_user
    ON projection_threads(assigned_user_id)
  `;
});
