import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";
import { Effect, Layer, Schema } from "effect";

import { toPersistenceSqlError } from "../Errors.ts";
import {
  DeleteSessionInput,
  DeleteUserSessionsInput,
  GetSessionInput,
  UserSession,
  UserSessionRepository,
  type UserSessionRepositoryShape,
} from "../Services/UserSessions.ts";

const makeUserSessionRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const insertRow = SqlSchema.void({
    Request: UserSession,
    execute: (row) =>
      sql`
        INSERT INTO user_sessions (session_id, user_id, created_at, expires_at)
        VALUES (${row.sessionId}, ${row.userId}, ${row.createdAt}, ${row.expiresAt})
      `,
  });

  const getByIdRow = SqlSchema.findOneOption({
    Request: GetSessionInput,
    Result: UserSession,
    execute: ({ sessionId }) =>
      sql`
        SELECT session_id AS "sessionId", user_id AS "userId",
               created_at AS "createdAt", expires_at AS "expiresAt"
        FROM user_sessions
        WHERE session_id = ${sessionId}
      `,
  });

  const deleteByIdRow = SqlSchema.void({
    Request: DeleteSessionInput,
    execute: ({ sessionId }) => sql`DELETE FROM user_sessions WHERE session_id = ${sessionId}`,
  });

  const deleteByUserIdRow = SqlSchema.void({
    Request: DeleteUserSessionsInput,
    execute: ({ userId }) => sql`DELETE FROM user_sessions WHERE user_id = ${userId}`,
  });

  const deleteExpiredRow = SqlSchema.void({
    Request: Schema.Void,
    execute: () => sql`DELETE FROM user_sessions WHERE expires_at < ${new Date().toISOString()}`,
  });

  const create: UserSessionRepositoryShape["create"] = (row) =>
    insertRow(row).pipe(Effect.mapError(toPersistenceSqlError("UserSessionRepository.create")));

  const getById: UserSessionRepositoryShape["getById"] = (input) =>
    getByIdRow(input).pipe(Effect.mapError(toPersistenceSqlError("UserSessionRepository.getById")));

  const deleteById: UserSessionRepositoryShape["deleteById"] = (input) =>
    deleteByIdRow(input).pipe(
      Effect.mapError(toPersistenceSqlError("UserSessionRepository.deleteById")),
    );

  const deleteByUserId: UserSessionRepositoryShape["deleteByUserId"] = (input) =>
    deleteByUserIdRow(input).pipe(
      Effect.mapError(toPersistenceSqlError("UserSessionRepository.deleteByUserId")),
    );

  const deleteExpired: UserSessionRepositoryShape["deleteExpired"] = () =>
    deleteExpiredRow().pipe(
      Effect.mapError(toPersistenceSqlError("UserSessionRepository.deleteExpired")),
    );

  return {
    create,
    getById,
    deleteById,
    deleteByUserId,
    deleteExpired,
  } satisfies UserSessionRepositoryShape;
});

export const UserSessionRepositoryLive = Layer.effect(
  UserSessionRepository,
  makeUserSessionRepository,
);
