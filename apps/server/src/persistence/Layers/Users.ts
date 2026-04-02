import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";
import { Effect, Layer, Schema } from "effect";

import { toPersistenceSqlError } from "../Errors.ts";
import {
  DeleteUserInput,
  GetUserByUsernameInput,
  GetUserInput,
  ProjectionUser,
  UserRepository,
  type UserRepositoryShape,
} from "../Services/Users.ts";

const makeUserRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const upsertRow = SqlSchema.void({
    Request: ProjectionUser,
    execute: (row) =>
      sql`
        INSERT INTO users (user_id, username, display_name, password_hash, role, created_at)
        VALUES (${row.userId}, ${row.username}, ${row.displayName}, ${row.passwordHash}, ${row.role}, ${row.createdAt})
        ON CONFLICT (user_id)
        DO UPDATE SET
          username = excluded.username,
          display_name = excluded.display_name,
          password_hash = excluded.password_hash,
          role = excluded.role
      `,
  });

  const getByIdRow = SqlSchema.findOneOption({
    Request: GetUserInput,
    Result: ProjectionUser,
    execute: ({ userId }) =>
      sql`
        SELECT user_id AS "userId", username, display_name AS "displayName",
               password_hash AS "passwordHash", role, created_at AS "createdAt"
        FROM users WHERE user_id = ${userId}
      `,
  });

  const getByUsernameRow = SqlSchema.findOneOption({
    Request: GetUserByUsernameInput,
    Result: ProjectionUser,
    execute: ({ username }) =>
      sql`
        SELECT user_id AS "userId", username, display_name AS "displayName",
               password_hash AS "passwordHash", role, created_at AS "createdAt"
        FROM users WHERE username = ${username} COLLATE NOCASE
      `,
  });

  const listAllRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionUser,
    execute: () =>
      sql`
        SELECT user_id AS "userId", username, display_name AS "displayName",
               password_hash AS "passwordHash", role, created_at AS "createdAt"
        FROM users ORDER BY created_at ASC
      `,
  });

  const countRows = SqlSchema.findOne({
    Request: Schema.Void,
    Result: Schema.Struct({ count: Schema.Number }),
    execute: () => sql`SELECT COUNT(*) AS "count" FROM users`,
  });

  const deleteRow = SqlSchema.void({
    Request: DeleteUserInput,
    execute: ({ userId }) => sql`DELETE FROM users WHERE user_id = ${userId}`,
  });

  const upsert: UserRepositoryShape["upsert"] = (row) =>
    upsertRow(row).pipe(Effect.mapError(toPersistenceSqlError("UserRepository.upsert")));

  const getById: UserRepositoryShape["getById"] = (input) =>
    getByIdRow(input).pipe(Effect.mapError(toPersistenceSqlError("UserRepository.getById")));

  const getByUsername: UserRepositoryShape["getByUsername"] = (input) =>
    getByUsernameRow(input).pipe(Effect.mapError(toPersistenceSqlError("UserRepository.getByUsername")));

  const listAll: UserRepositoryShape["listAll"] = () =>
    listAllRows().pipe(Effect.mapError(toPersistenceSqlError("UserRepository.listAll")));

  const count: UserRepositoryShape["count"] = () =>
    countRows().pipe(
      Effect.map((row) => row.count),
      Effect.mapError(toPersistenceSqlError("UserRepository.count")),
    );

  const deleteById: UserRepositoryShape["deleteById"] = (input) =>
    deleteRow(input).pipe(Effect.mapError(toPersistenceSqlError("UserRepository.deleteById")));

  return { upsert, getById, getByUsername, listAll, count, deleteById } satisfies UserRepositoryShape;
});

export const UserRepositoryLive = Layer.effect(UserRepository, makeUserRepository);
