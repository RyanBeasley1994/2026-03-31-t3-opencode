# User Accounts & Thread Assignment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add user accounts with login, admin user management, and thread assignment so teams can organize who's working on what.

**Architecture:** SQLite-backed users + sessions tables, HTTP-only cookie auth on both HTTP and WebSocket, argon2 password hashing. Auth is checked at the HTTP/WS upgrade layer in `wsServer.ts`. New `UserService` Effect service handles all user/session CRUD. Web app gets login/setup routes and a thread assignment filter in the sidebar.

**Tech Stack:** Effect (services/layers/schemas), SQLite (existing), `@node-rs/argon2`, TanStack Router, Zustand, React Query

---

## File Structure

### New Files

| File                                                             | Responsibility                                                  |
| ---------------------------------------------------------------- | --------------------------------------------------------------- |
| `packages/contracts/src/auth.ts`                                 | User/session schemas, auth WS methods, auth HTTP types          |
| `apps/server/src/persistence/Migrations/020_Users.ts`            | Users + user_sessions tables                                    |
| `apps/server/src/persistence/Migrations/021_ThreadAssignment.ts` | Add `assigned_user_id` to `projection_threads`                  |
| `apps/server/src/persistence/Services/Users.ts`                  | UserRepository service interface                                |
| `apps/server/src/persistence/Services/UserSessions.ts`           | UserSessionRepository service interface                         |
| `apps/server/src/persistence/Layers/Users.ts`                    | UserRepository SQLite implementation                            |
| `apps/server/src/persistence/Layers/UserSessions.ts`             | UserSessionRepository SQLite implementation                     |
| `apps/server/src/auth/UserService.ts`                            | UserService Effect service (hashing, login, session validation) |
| `apps/server/src/auth/UserServiceLive.ts`                        | UserService live layer implementation                           |
| `apps/web/src/lib/authApi.ts`                                    | Auth HTTP client functions (login, logout, me, setup, users)    |
| `apps/web/src/authStore.ts`                                      | Zustand auth state (currentUser, isAuthenticated)               |
| `apps/web/src/routes/login.tsx`                                  | Login page route                                                |
| `apps/web/src/routes/setup.tsx`                                  | First-run admin setup route                                     |
| `apps/web/src/routes/settings.users.tsx`                         | User management settings page                                   |
| `apps/web/src/components/auth/LoginForm.tsx`                     | Login form component                                            |
| `apps/web/src/components/auth/SetupForm.tsx`                     | Admin setup form component                                      |
| `apps/web/src/components/auth/AuthGuard.tsx`                     | Auth gate wrapper for root route                                |
| `apps/web/src/components/settings/UsersPanel.tsx`                | Admin user management panel                                     |
| `apps/web/src/components/ThreadAssignmentDropdown.tsx`           | Thread assignment dropdown                                      |

### Modified Files

| File                                                        | Changes                                                              |
| ----------------------------------------------------------- | -------------------------------------------------------------------- |
| `packages/contracts/src/baseSchemas.ts`                     | Add `UserId` branded type                                            |
| `packages/contracts/src/index.ts`                           | Re-export auth module                                                |
| `packages/contracts/src/ws.ts`                              | Add auth WS methods + request bodies                                 |
| `packages/contracts/src/orchestration.ts`                   | Add `assignedUserId` to `OrchestrationThread`                        |
| `apps/server/src/persistence/Migrations.ts`                 | Register migrations 020, 021                                         |
| `apps/server/src/persistence/Services/ProjectionThreads.ts` | Add `assignedUserId` field                                           |
| `apps/server/src/persistence/Layers/ProjectionThreads.ts`   | Include `assigned_user_id` in SQL queries                            |
| `apps/server/src/config.ts`                                 | Remove `webUiAuth` (replaced by app-level auth)                      |
| `apps/server/src/serverLayers.ts`                           | Wire UserService + repositories into layer tree                      |
| `apps/server/src/wsServer.ts`                               | Cookie auth, HTTP auth endpoints, WS auth methods, remove basic auth |
| `apps/server/package.json`                                  | Add `@node-rs/argon2` dependency                                     |
| `apps/web/src/routes/__root.tsx`                            | Wrap with AuthGuard                                                  |
| `apps/web/src/store.ts`                                     | Add `assignedUserId` to thread mapping                               |
| `apps/web/src/types.ts`                                     | Add `assignedUserId` to Thread interface                             |
| `apps/web/src/components/Sidebar.tsx`                       | Thread filter by user, user badge on threads                         |
| `apps/web/src/components/chat/ChatHeader.tsx`               | Thread assignment dropdown                                           |
| `apps/web/src/components/settings/SettingsSidebarNav.tsx`   | Add "Users" nav item                                                 |
| `docker-compose.yml`                                        | Remove basic auth env vars, simplify nginx config                    |

---

## Task 1: Add UserId to Contracts

**Files:**

- Modify: `packages/contracts/src/baseSchemas.ts:44`
- Create: `packages/contracts/src/auth.ts`
- Modify: `packages/contracts/src/index.ts`

- [ ] **Step 1: Add UserId branded type to baseSchemas.ts**

Add after the `CheckpointRef` lines (line 44):

```typescript
export const UserId = makeEntityId("UserId");
export type UserId = typeof UserId.Type;

export const UserSessionId = makeEntityId("UserSessionId");
export type UserSessionId = typeof UserSessionId.Type;
```

- [ ] **Step 2: Create auth.ts contracts**

Create `packages/contracts/src/auth.ts`:

```typescript
import { Schema } from "effect";
import { IsoDateTime, TrimmedNonEmptyString, UserId } from "./baseSchemas";

export const UserRole = Schema.Literal("admin", "member");
export type UserRole = typeof UserRole.Type;

export const User = Schema.Struct({
  id: UserId,
  username: TrimmedNonEmptyString,
  displayName: TrimmedNonEmptyString,
  role: UserRole,
  createdAt: IsoDateTime,
});
export type User = typeof User.Type;

export const LoginInput = Schema.Struct({
  username: TrimmedNonEmptyString,
  password: TrimmedNonEmptyString,
});
export type LoginInput = typeof LoginInput.Type;

export const SetupInput = Schema.Struct({
  username: TrimmedNonEmptyString,
  displayName: TrimmedNonEmptyString,
  password: TrimmedNonEmptyString,
});
export type SetupInput = typeof SetupInput.Type;

export const CreateUserInput = Schema.Struct({
  username: TrimmedNonEmptyString,
  displayName: TrimmedNonEmptyString,
  password: TrimmedNonEmptyString,
  role: UserRole.pipe(Schema.withDecodingDefault(() => "member" as const)),
});
export type CreateUserInput = typeof CreateUserInput.Type;

export const AuthResponse = Schema.Struct({
  user: User,
});
export type AuthResponse = typeof AuthResponse.Type;

export const SetupRequiredResponse = Schema.Struct({
  required: Schema.Boolean,
});
export type SetupRequiredResponse = typeof SetupRequiredResponse.Type;

export const UserListResponse = Schema.Struct({
  users: Schema.Array(User),
});
export type UserListResponse = typeof UserListResponse.Type;
```

- [ ] **Step 3: Export auth from contracts index**

In `packages/contracts/src/index.ts`, add the re-export:

```typescript
export * from "./auth";
```

- [ ] **Step 4: Run typecheck**

Run: `cd /Users/ryan/Documents/Repos/2026-03-31-t3-opencode && bun typecheck`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/contracts/src/baseSchemas.ts packages/contracts/src/auth.ts packages/contracts/src/index.ts
git commit -m "feat(contracts): add UserId branded type and auth schemas"
```

---

## Task 2: Database Migrations

**Files:**

- Create: `apps/server/src/persistence/Migrations/020_Users.ts`
- Create: `apps/server/src/persistence/Migrations/021_ThreadAssignment.ts`
- Modify: `apps/server/src/persistence/Migrations.ts`

- [ ] **Step 1: Create migration 020_Users.ts**

Create `apps/server/src/persistence/Migrations/020_Users.ts`:

```typescript
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Effect from "effect/Effect";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS users (
      user_id TEXT PRIMARY KEY,
      username TEXT NOT NULL UNIQUE COLLATE NOCASE,
      display_name TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'member',
      created_at TEXT NOT NULL
    )
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS user_sessions (
      session_id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_user_sessions_user_id
    ON user_sessions(user_id)
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_user_sessions_expires_at
    ON user_sessions(expires_at)
  `;
});
```

- [ ] **Step 2: Create migration 021_ThreadAssignment.ts**

Create `apps/server/src/persistence/Migrations/021_ThreadAssignment.ts`:

```typescript
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
```

- [ ] **Step 3: Register migrations in Migrations.ts**

Add imports at the end of the import block (after line 34):

```typescript
import Migration0020 from "./Migrations/020_Users.ts";
import Migration0021 from "./Migrations/021_ThreadAssignment.ts";
```

Add entries at the end of the `migrationEntries` array (after line 65):

```typescript
  [20, "Users", Migration0020],
  [21, "ThreadAssignment", Migration0021],
```

- [ ] **Step 4: Run typecheck**

Run: `cd /Users/ryan/Documents/Repos/2026-03-31-t3-opencode && bun typecheck`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/persistence/Migrations/020_Users.ts apps/server/src/persistence/Migrations/021_ThreadAssignment.ts apps/server/src/persistence/Migrations.ts
git commit -m "feat(server): add users and thread assignment database migrations"
```

---

## Task 3: User Repository Service & Layer

**Files:**

- Create: `apps/server/src/persistence/Services/Users.ts`
- Create: `apps/server/src/persistence/Layers/Users.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/server/src/persistence/Layers/Users.test.ts`:

```typescript
import { Effect, Option } from "effect";
import { describe, expect, it } from "vitest";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { UserRepository } from "../Services/Users.ts";
import { UserRepositoryLive } from "./Users.ts";
import { SqlitePersistenceMemory } from "./Sqlite.ts";
import { runMigrations } from "../Migrations.ts";

const TestLayer = UserRepositoryLive.pipe(Effect.provideLayer(SqlitePersistenceMemory));

const runTest = <A, E>(effect: Effect.Effect<A, E, UserRepository | SqlClient.SqlClient>) =>
  Effect.runPromise(
    effect.pipe(Effect.provide(UserRepositoryLive), Effect.provide(SqlitePersistenceMemory)),
  );

describe("UserRepository", () => {
  it("creates and retrieves a user", async () => {
    await runTest(
      Effect.gen(function* () {
        yield* runMigrations();
        const repo = yield* UserRepository;
        const now = new Date().toISOString();
        yield* repo.upsert({
          userId: "user-1" as any,
          username: "testuser",
          displayName: "Test User",
          passwordHash: "hashed",
          role: "admin",
          createdAt: now,
        });
        const found = yield* repo.getById({ userId: "user-1" as any });
        expect(Option.isSome(found)).toBe(true);
        if (Option.isSome(found)) {
          expect(found.value.username).toBe("testuser");
          expect(found.value.role).toBe("admin");
        }
      }),
    );
  });

  it("finds user by username", async () => {
    await runTest(
      Effect.gen(function* () {
        yield* runMigrations();
        const repo = yield* UserRepository;
        const now = new Date().toISOString();
        yield* repo.upsert({
          userId: "user-2" as any,
          username: "findme",
          displayName: "Find Me",
          passwordHash: "hashed",
          role: "member",
          createdAt: now,
        });
        const found = yield* repo.getByUsername({ username: "findme" });
        expect(Option.isSome(found)).toBe(true);
      }),
    );
  });

  it("lists all users", async () => {
    await runTest(
      Effect.gen(function* () {
        yield* runMigrations();
        const repo = yield* UserRepository;
        const now = new Date().toISOString();
        yield* repo.upsert({
          userId: "user-3" as any,
          username: "user_a",
          displayName: "User A",
          passwordHash: "hashed",
          role: "admin",
          createdAt: now,
        });
        yield* repo.upsert({
          userId: "user-4" as any,
          username: "user_b",
          displayName: "User B",
          passwordHash: "hashed",
          role: "member",
          createdAt: now,
        });
        const all = yield* repo.listAll();
        expect(all.length).toBeGreaterThanOrEqual(2);
      }),
    );
  });

  it("counts users", async () => {
    await runTest(
      Effect.gen(function* () {
        yield* runMigrations();
        const repo = yield* UserRepository;
        const count = yield* repo.count();
        expect(count).toBeGreaterThanOrEqual(0);
      }),
    );
  });

  it("deletes a user", async () => {
    await runTest(
      Effect.gen(function* () {
        yield* runMigrations();
        const repo = yield* UserRepository;
        const now = new Date().toISOString();
        yield* repo.upsert({
          userId: "user-del" as any,
          username: "deleteme",
          displayName: "Delete Me",
          passwordHash: "hashed",
          role: "member",
          createdAt: now,
        });
        yield* repo.deleteById({ userId: "user-del" as any });
        const found = yield* repo.getById({ userId: "user-del" as any });
        expect(Option.isNone(found)).toBe(true);
      }),
    );
  });
});
```

- [ ] **Step 2: Create UserRepository service interface**

Create `apps/server/src/persistence/Services/Users.ts`:

```typescript
import { UserId, IsoDateTime } from "@t3tools/contracts";
import { Option, Schema, ServiceMap } from "effect";
import type { Effect } from "effect";
import type { ProjectionRepositoryError } from "../Errors.ts";

export const ProjectionUser = Schema.Struct({
  userId: UserId,
  username: Schema.String,
  displayName: Schema.String,
  passwordHash: Schema.String,
  role: Schema.Literal("admin", "member"),
  createdAt: IsoDateTime,
});
export type ProjectionUser = typeof ProjectionUser.Type;

export const GetUserInput = Schema.Struct({ userId: UserId });
export type GetUserInput = typeof GetUserInput.Type;

export const GetUserByUsernameInput = Schema.Struct({ username: Schema.String });
export type GetUserByUsernameInput = typeof GetUserByUsernameInput.Type;

export const DeleteUserInput = Schema.Struct({ userId: UserId });
export type DeleteUserInput = typeof DeleteUserInput.Type;

export interface UserRepositoryShape {
  readonly upsert: (row: ProjectionUser) => Effect.Effect<void, ProjectionRepositoryError>;
  readonly getById: (
    input: GetUserInput,
  ) => Effect.Effect<Option.Option<ProjectionUser>, ProjectionRepositoryError>;
  readonly getByUsername: (
    input: GetUserByUsernameInput,
  ) => Effect.Effect<Option.Option<ProjectionUser>, ProjectionRepositoryError>;
  readonly listAll: () => Effect.Effect<ReadonlyArray<ProjectionUser>, ProjectionRepositoryError>;
  readonly count: () => Effect.Effect<number, ProjectionRepositoryError>;
  readonly deleteById: (input: DeleteUserInput) => Effect.Effect<void, ProjectionRepositoryError>;
}

export class UserRepository extends ServiceMap.Service<UserRepository, UserRepositoryShape>()(
  "t3/persistence/Services/Users/UserRepository",
) {}
```

- [ ] **Step 3: Create UserRepository live layer**

Create `apps/server/src/persistence/Layers/Users.ts`:

```typescript
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
    getByUsernameRow(input).pipe(
      Effect.mapError(toPersistenceSqlError("UserRepository.getByUsername")),
    );

  const listAll: UserRepositoryShape["listAll"] = () =>
    listAllRows().pipe(Effect.mapError(toPersistenceSqlError("UserRepository.listAll")));

  const count: UserRepositoryShape["count"] = () =>
    countRows().pipe(
      Effect.map((row) => row.count),
      Effect.mapError(toPersistenceSqlError("UserRepository.count")),
    );

  const deleteById: UserRepositoryShape["deleteById"] = (input) =>
    deleteRow(input).pipe(Effect.mapError(toPersistenceSqlError("UserRepository.deleteById")));

  return {
    upsert,
    getById,
    getByUsername,
    listAll,
    count,
    deleteById,
  } satisfies UserRepositoryShape;
});

export const UserRepositoryLive = Layer.effect(UserRepository, makeUserRepository);
```

- [ ] **Step 4: Run the test to verify it fails then passes**

Run: `cd /Users/ryan/Documents/Repos/2026-03-31-t3-opencode && bun run test apps/server/src/persistence/Layers/Users.test.ts`
Expected: Tests should pass once the code is in place. If they fail, fix issues.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/persistence/Services/Users.ts apps/server/src/persistence/Layers/Users.ts apps/server/src/persistence/Layers/Users.test.ts
git commit -m "feat(server): add UserRepository service and SQLite layer"
```

---

## Task 4: User Session Repository Service & Layer

**Files:**

- Create: `apps/server/src/persistence/Services/UserSessions.ts`
- Create: `apps/server/src/persistence/Layers/UserSessions.ts`

- [ ] **Step 1: Create UserSessionRepository service interface**

Create `apps/server/src/persistence/Services/UserSessions.ts`:

```typescript
import { UserId, UserSessionId, IsoDateTime } from "@t3tools/contracts";
import { Option, Schema, ServiceMap } from "effect";
import type { Effect } from "effect";
import type { ProjectionRepositoryError } from "../Errors.ts";

export const UserSession = Schema.Struct({
  sessionId: UserSessionId,
  userId: UserId,
  createdAt: IsoDateTime,
  expiresAt: IsoDateTime,
});
export type UserSession = typeof UserSession.Type;

export const GetSessionInput = Schema.Struct({ sessionId: UserSessionId });
export type GetSessionInput = typeof GetSessionInput.Type;

export const DeleteSessionInput = Schema.Struct({ sessionId: UserSessionId });
export type DeleteSessionInput = typeof DeleteSessionInput.Type;

export const DeleteUserSessionsInput = Schema.Struct({ userId: UserId });
export type DeleteUserSessionsInput = typeof DeleteUserSessionsInput.Type;

export interface UserSessionRepositoryShape {
  readonly create: (row: UserSession) => Effect.Effect<void, ProjectionRepositoryError>;
  readonly getById: (
    input: GetSessionInput,
  ) => Effect.Effect<Option.Option<UserSession>, ProjectionRepositoryError>;
  readonly deleteById: (
    input: DeleteSessionInput,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
  readonly deleteByUserId: (
    input: DeleteUserSessionsInput,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
  readonly deleteExpired: () => Effect.Effect<void, ProjectionRepositoryError>;
}

export class UserSessionRepository extends ServiceMap.Service<
  UserSessionRepository,
  UserSessionRepositoryShape
>()("t3/persistence/Services/UserSessions/UserSessionRepository") {}
```

- [ ] **Step 2: Create UserSessionRepository live layer**

Create `apps/server/src/persistence/Layers/UserSessions.ts`:

```typescript
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
```

- [ ] **Step 3: Run typecheck**

Run: `cd /Users/ryan/Documents/Repos/2026-03-31-t3-opencode && bun typecheck`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add apps/server/src/persistence/Services/UserSessions.ts apps/server/src/persistence/Layers/UserSessions.ts
git commit -m "feat(server): add UserSessionRepository service and SQLite layer"
```

---

## Task 5: UserService (Auth Business Logic)

**Files:**

- Create: `apps/server/src/auth/UserService.ts`
- Create: `apps/server/src/auth/UserServiceLive.ts`
- Modify: `apps/server/package.json`

- [ ] **Step 1: Install argon2**

Run: `cd /Users/ryan/Documents/Repos/2026-03-31-t3-opencode/apps/server && bun add @node-rs/argon2`

- [ ] **Step 2: Create UserService interface**

Create `apps/server/src/auth/UserService.ts`:

```typescript
import { Schema, ServiceMap } from "effect";
import type { Effect, Option } from "effect";
import type { User, UserId } from "@t3tools/contracts";

export class AuthError extends Schema.TaggedErrorClass<AuthError>()("AuthError", {
  reason: Schema.Literal(
    "invalid_credentials",
    "user_exists",
    "not_found",
    "not_admin",
    "setup_already_done",
  ),
  message: Schema.String,
}) {}

export interface UserServiceShape {
  readonly setup: (input: {
    username: string;
    displayName: string;
    password: string;
  }) => Effect.Effect<{ user: User; sessionId: string }, AuthError>;

  readonly login: (input: {
    username: string;
    password: string;
  }) => Effect.Effect<{ user: User; sessionId: string }, AuthError>;

  readonly logout: (sessionId: string) => Effect.Effect<void, AuthError>;

  readonly validateSession: (sessionId: string) => Effect.Effect<Option.Option<User>>;

  readonly isSetupRequired: () => Effect.Effect<boolean>;

  readonly listUsers: () => Effect.Effect<ReadonlyArray<User>>;

  readonly createUser: (input: {
    username: string;
    displayName: string;
    password: string;
    role: "admin" | "member";
    callerRole: "admin" | "member";
  }) => Effect.Effect<User, AuthError>;

  readonly deleteUser: (input: {
    userId: UserId;
    callerRole: "admin" | "member";
  }) => Effect.Effect<void, AuthError>;
}

export class UserService extends ServiceMap.Service<UserService, UserServiceShape>()(
  "t3/auth/UserService",
) {}
```

- [ ] **Step 3: Create UserService live layer**

Create `apps/server/src/auth/UserServiceLive.ts`:

```typescript
import { Effect, Layer, Option } from "effect";
import { hash, verify } from "@node-rs/argon2";
import type { User, UserId } from "@t3tools/contracts";

import { UserRepository } from "../persistence/Services/Users.ts";
import { UserSessionRepository } from "../persistence/Services/UserSessions.ts";
import { AuthError, UserService, type UserServiceShape } from "./UserService.ts";

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

function generateId(): string {
  return crypto.randomUUID();
}

function toPublicUser(row: {
  userId: string;
  username: string;
  displayName: string;
  role: "admin" | "member";
  createdAt: string;
}): User {
  return {
    id: row.userId as any,
    username: row.username,
    displayName: row.displayName,
    role: row.role,
    createdAt: row.createdAt,
  };
}

const makeUserService = Effect.gen(function* () {
  const userRepo = yield* UserRepository;
  const sessionRepo = yield* UserSessionRepository;

  const isSetupRequired: UserServiceShape["isSetupRequired"] = () =>
    userRepo.count().pipe(
      Effect.map((count) => count === 0),
      Effect.orElseSucceed(() => true),
    );

  const setup: UserServiceShape["setup"] = (input) =>
    Effect.gen(function* () {
      const count = yield* userRepo.count();
      if (count > 0) {
        return yield* new AuthError({
          reason: "setup_already_done",
          message: "Admin account already exists",
        });
      }

      const userId = generateId() as UserId;
      const now = new Date().toISOString();
      const passwordHash = yield* Effect.promise(() => hash(input.password));

      yield* userRepo.upsert({
        userId,
        username: input.username,
        displayName: input.displayName,
        passwordHash,
        role: "admin",
        createdAt: now,
      });

      const sessionId = generateId();
      const expiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString();
      yield* sessionRepo.create({
        sessionId: sessionId as any,
        userId,
        createdAt: now,
        expiresAt,
      });

      return {
        user: toPublicUser({
          userId: userId as string,
          username: input.username,
          displayName: input.displayName,
          role: "admin",
          createdAt: now,
        }),
        sessionId,
      };
    });

  const login: UserServiceShape["login"] = (input) =>
    Effect.gen(function* () {
      const maybeUser = yield* userRepo.getByUsername({ username: input.username });
      if (Option.isNone(maybeUser)) {
        return yield* new AuthError({
          reason: "invalid_credentials",
          message: "Invalid username or password",
        });
      }
      const user = maybeUser.value;

      const valid = yield* Effect.promise(() => verify(user.passwordHash, input.password));
      if (!valid) {
        return yield* new AuthError({
          reason: "invalid_credentials",
          message: "Invalid username or password",
        });
      }

      const sessionId = generateId();
      const now = new Date().toISOString();
      const expiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString();
      yield* sessionRepo.create({
        sessionId: sessionId as any,
        userId: user.userId,
        createdAt: now,
        expiresAt,
      });

      // Clean up expired sessions periodically
      yield* sessionRepo.deleteExpired().pipe(Effect.ignoreLogged);

      return { user: toPublicUser(user), sessionId };
    });

  const logout: UserServiceShape["logout"] = (sessionId) =>
    sessionRepo
      .deleteById({ sessionId: sessionId as any })
      .pipe(
        Effect.mapError(() => new AuthError({ reason: "not_found", message: "Session not found" })),
      );

  const validateSession: UserServiceShape["validateSession"] = (sessionId) =>
    Effect.gen(function* () {
      const maybeSession = yield* sessionRepo
        .getById({ sessionId: sessionId as any })
        .pipe(Effect.orElseSucceed(() => Option.none()));
      if (Option.isNone(maybeSession)) return Option.none();

      const session = maybeSession.value;
      if (new Date(session.expiresAt) < new Date()) {
        yield* sessionRepo.deleteById({ sessionId: sessionId as any }).pipe(Effect.ignoreLogged);
        return Option.none();
      }

      const maybeUser = yield* userRepo
        .getById({ userId: session.userId })
        .pipe(Effect.orElseSucceed(() => Option.none()));
      if (Option.isNone(maybeUser)) return Option.none();

      return Option.some(toPublicUser(maybeUser.value));
    });

  const listUsers: UserServiceShape["listUsers"] = () =>
    userRepo.listAll().pipe(
      Effect.map((users) => users.map(toPublicUser)),
      Effect.orElseSucceed(() => []),
    );

  const createUser: UserServiceShape["createUser"] = (input) =>
    Effect.gen(function* () {
      if (input.callerRole !== "admin") {
        return yield* new AuthError({
          reason: "not_admin",
          message: "Only admins can create users",
        });
      }

      const existing = yield* userRepo.getByUsername({ username: input.username });
      if (Option.isSome(existing)) {
        return yield* new AuthError({ reason: "user_exists", message: "Username already taken" });
      }

      const userId = generateId() as UserId;
      const now = new Date().toISOString();
      const passwordHash = yield* Effect.promise(() => hash(input.password));

      yield* userRepo.upsert({
        userId,
        username: input.username,
        displayName: input.displayName,
        passwordHash,
        role: input.role,
        createdAt: now,
      });

      return toPublicUser({
        userId: userId as string,
        username: input.username,
        displayName: input.displayName,
        role: input.role,
        createdAt: now,
      });
    });

  const deleteUser: UserServiceShape["deleteUser"] = (input) =>
    Effect.gen(function* () {
      if (input.callerRole !== "admin") {
        return yield* new AuthError({
          reason: "not_admin",
          message: "Only admins can delete users",
        });
      }

      yield* sessionRepo.deleteByUserId({ userId: input.userId });
      yield* userRepo.deleteById({ userId: input.userId });
    });

  return {
    setup,
    login,
    logout,
    validateSession,
    isSetupRequired,
    listUsers,
    createUser,
    deleteUser,
  } satisfies UserServiceShape;
});

export const UserServiceLive = Layer.effect(UserService, makeUserService);
```

- [ ] **Step 4: Run typecheck**

Run: `cd /Users/ryan/Documents/Repos/2026-03-31-t3-opencode && bun typecheck`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/auth/UserService.ts apps/server/src/auth/UserServiceLive.ts apps/server/package.json apps/server/bun.lock
git commit -m "feat(server): add UserService with argon2 password hashing and session management"
```

---

## Task 6: Wire Auth into Server Layers

**Files:**

- Modify: `apps/server/src/serverLayers.ts`
- Modify: `apps/server/src/wsServer.ts` (ServerRuntimeServices type)

- [ ] **Step 1: Add UserService to server runtime services type**

In `apps/server/src/wsServer.ts`, add import (near line 56):

```typescript
import { UserService } from "./auth/UserService.ts";
```

Add `UserService` to the `ServerRuntimeServices` type union (after line 318):

```typescript
export type ServerRuntimeServices =
  | ServerCoreRuntimeServices
  | GitManager
  | GitCore
  | GitHubCli
  | TerminalManager
  | Keybindings
  | ServerSettingsService
  | Open
  | AnalyticsService
  | GithubAppAutomation
  | UserService;
```

- [ ] **Step 2: Wire repositories and UserService into serverLayers.ts**

In `apps/server/src/serverLayers.ts`, add imports:

```typescript
import { UserRepositoryLive } from "./persistence/Layers/Users.ts";
import { UserSessionRepositoryLive } from "./persistence/Layers/UserSessions.ts";
import { UserServiceLive } from "./auth/UserServiceLive.ts";
```

In `makeServerRuntimeServicesLayer()`, add the user service layer after the `githubAutomationLayer` definition (before the final return):

```typescript
const userServiceLayer = UserServiceLive.pipe(
  Layer.provide(UserRepositoryLive),
  Layer.provide(UserSessionRepositoryLive),
);
```

Update the final return to include it:

```typescript
return Layer.mergeAll(baseRuntimeLayer, githubAutomationLayer, userServiceLayer).pipe(
  Layer.provideMerge(NodeServices.layer),
);
```

- [ ] **Step 3: Run typecheck**

Run: `cd /Users/ryan/Documents/Repos/2026-03-31-t3-opencode && bun typecheck`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add apps/server/src/serverLayers.ts apps/server/src/wsServer.ts
git commit -m "feat(server): wire UserService into server runtime layer tree"
```

---

## Task 7: HTTP Auth Endpoints & Cookie Auth in wsServer

**Files:**

- Modify: `apps/server/src/wsServer.ts`

This is the largest task. It adds HTTP auth routes and replaces basic auth with cookie-based session auth.

- [ ] **Step 1: Add cookie helper imports and UserService resolution**

At the top of `wsServer.ts`, add import:

```typescript
import { UserService } from "./auth/UserService.ts";
import type { User } from "@t3tools/contracts";
```

Inside `createServer` (after line 362 where `githubAppAutomation` is yielded), add:

```typescript
const userService = yield * UserService;
```

- [ ] **Step 2: Add cookie parsing helper**

Add after the `toPosixRelativePath` function (around line 211):

```typescript
function parseCookies(cookieHeader: string | undefined): Record<string, string> {
  if (!cookieHeader) return {};
  const cookies: Record<string, string> = {};
  for (const pair of cookieHeader.split(";")) {
    const [name, ...rest] = pair.trim().split("=");
    if (name) cookies[name.trim()] = rest.join("=").trim();
  }
  return cookies;
}

function getSessionIdFromRequest(req: http.IncomingMessage): string | null {
  const cookies = parseCookies(req.headers.cookie);
  return cookies["t3code_session"] ?? null;
}

function setSessionCookie(res: http.ServerResponse, sessionId: string): void {
  const maxAge = 30 * 24 * 60 * 60; // 30 days in seconds
  res.setHeader(
    "Set-Cookie",
    `t3code_session=${sessionId}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${maxAge}`,
  );
}

function clearSessionCookie(res: http.ServerResponse): void {
  res.setHeader("Set-Cookie", "t3code_session=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0");
}
```

- [ ] **Step 3: Add HTTP auth routes**

Inside the HTTP server request handler (inside `Effect.gen` around line 543), add auth routes BEFORE the `webUiAuth` check. Insert right after `const url = new URL(...)` on line 544:

```typescript
// ── Auth API routes (no auth required) ──────────────────────
if (url.pathname === "/api/auth/setup-required") {
  const required = yield * userService.isSetupRequired;
  respond(200, { "Content-Type": "application/json" }, JSON.stringify({ required }));
  return;
}

if (url.pathname === "/api/auth/setup" && req.method === "POST") {
  const body = JSON.parse(Buffer.from(yield * readHttpRequestBody(req)).toString("utf8"));
  const result =
    yield *
    userService
      .setup({
        username: body.username,
        displayName: body.displayName,
        password: body.password,
      })
      .pipe(Effect.mapError((e) => new RouteRequestError({ message: e.message })));
  setSessionCookie(res, result.sessionId);
  respond(200, { "Content-Type": "application/json" }, JSON.stringify({ user: result.user }));
  return;
}

if (url.pathname === "/api/auth/login" && req.method === "POST") {
  const body = JSON.parse(Buffer.from(yield * readHttpRequestBody(req)).toString("utf8"));
  const result =
    yield *
    userService
      .login({
        username: body.username,
        password: body.password,
      })
      .pipe(Effect.mapError((e) => new RouteRequestError({ message: e.message })));
  setSessionCookie(res, result.sessionId);
  respond(200, { "Content-Type": "application/json" }, JSON.stringify({ user: result.user }));
  return;
}

if (url.pathname === "/api/auth/logout" && req.method === "POST") {
  const sessionId = getSessionIdFromRequest(req);
  if (sessionId) {
    yield * userService.logout(sessionId).pipe(Effect.ignoreLogged);
  }
  clearSessionCookie(res);
  respond(200, { "Content-Type": "application/json" }, JSON.stringify({}));
  return;
}

if (url.pathname === "/api/auth/me") {
  const sessionId = getSessionIdFromRequest(req);
  if (!sessionId) {
    respond(
      401,
      { "Content-Type": "application/json" },
      JSON.stringify({ error: "Not authenticated" }),
    );
    return;
  }
  const maybeUser = yield * userService.validateSession(sessionId);
  if (Option.isNone(maybeUser)) {
    clearSessionCookie(res);
    respond(
      401,
      { "Content-Type": "application/json" },
      JSON.stringify({ error: "Session expired" }),
    );
    return;
  }
  respond(200, { "Content-Type": "application/json" }, JSON.stringify({ user: maybeUser.value }));
  return;
}

if (url.pathname === "/api/auth/users") {
  if (req.method === "GET") {
    const sessionId = getSessionIdFromRequest(req);
    if (!sessionId) {
      respond(
        401,
        { "Content-Type": "application/json" },
        JSON.stringify({ error: "Not authenticated" }),
      );
      return;
    }
    const maybeUser = yield * userService.validateSession(sessionId);
    if (Option.isNone(maybeUser)) {
      respond(
        401,
        { "Content-Type": "application/json" },
        JSON.stringify({ error: "Session expired" }),
      );
      return;
    }
    const users = yield * userService.listUsers;
    respond(200, { "Content-Type": "application/json" }, JSON.stringify({ users }));
    return;
  }

  if (req.method === "POST") {
    const sessionId = getSessionIdFromRequest(req);
    if (!sessionId) {
      respond(
        401,
        { "Content-Type": "application/json" },
        JSON.stringify({ error: "Not authenticated" }),
      );
      return;
    }
    const maybeCaller = yield * userService.validateSession(sessionId);
    if (Option.isNone(maybeCaller)) {
      respond(
        401,
        { "Content-Type": "application/json" },
        JSON.stringify({ error: "Session expired" }),
      );
      return;
    }
    const body = JSON.parse(Buffer.from(yield * readHttpRequestBody(req)).toString("utf8"));
    const user =
      yield *
      userService
        .createUser({
          username: body.username,
          displayName: body.displayName,
          password: body.password,
          role: body.role ?? "member",
          callerRole: maybeCaller.value.role,
        })
        .pipe(Effect.mapError((e) => new RouteRequestError({ message: e.message })));
    respond(201, { "Content-Type": "application/json" }, JSON.stringify({ user }));
    return;
  }
}

if (url.pathname.startsWith("/api/auth/users/") && req.method === "DELETE") {
  const sessionId = getSessionIdFromRequest(req);
  if (!sessionId) {
    respond(
      401,
      { "Content-Type": "application/json" },
      JSON.stringify({ error: "Not authenticated" }),
    );
    return;
  }
  const maybeCaller = yield * userService.validateSession(sessionId);
  if (Option.isNone(maybeCaller)) {
    respond(
      401,
      { "Content-Type": "application/json" },
      JSON.stringify({ error: "Session expired" }),
    );
    return;
  }
  const targetUserId = url.pathname.slice("/api/auth/users/".length);
  yield *
    userService
      .deleteUser({
        userId: targetUserId as any,
        callerRole: maybeCaller.value.role,
      })
      .pipe(Effect.mapError((e) => new RouteRequestError({ message: e.message })));
  respond(200, { "Content-Type": "application/json" }, JSON.stringify({}));
  return;
}

// ── Existing auth check (skip for auth routes above) ─────
```

- [ ] **Step 4: Replace basic auth with cookie auth on WebSocket upgrade**

Replace the WebSocket upgrade auth check (lines 1243-1267) with:

```typescript
httpServer.on("upgrade", (request, socket, head) => {
  socket.on("error", () => {});

  // Cookie-based session auth for WebSocket
  const sessionId = getSessionIdFromRequest(request);

  // If auth token is set (desktop mode), allow token-based auth
  if (authToken) {
    let providedToken: string | null = null;
    try {
      const url = new URL(request.url ?? "/", `http://localhost:${port}`);
      providedToken = url.searchParams.get("token");
    } catch {
      rejectUpgrade(socket, 400, "Invalid WebSocket URL");
      return;
    }

    if (providedToken === authToken) {
      wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit("connection", ws, request);
      });
      return;
    }
  }

  // Cookie-based session validation
  if (!sessionId) {
    // If no users exist yet (setup not done), allow connection
    void runPromise(
      userService.isSetupRequired.pipe(
        Effect.tap((required) => {
          if (required) {
            wss.handleUpgrade(request, socket, head, (ws) => {
              wss.emit("connection", ws, request);
            });
          } else {
            rejectUpgrade(socket, 401, "Unauthorized WebSocket connection");
          }
        }),
        Effect.ignoreLogged,
      ),
    );
    return;
  }

  void runPromise(
    userService.validateSession(sessionId).pipe(
      Effect.tap((maybeUser) => {
        if (Option.isNone(maybeUser)) {
          rejectUpgrade(socket, 401, "Session expired");
        } else {
          wss.handleUpgrade(request, socket, head, (ws) => {
            wss.emit("connection", ws, request);
          });
        }
      }),
      Effect.ignoreLogged,
    ),
  );
});
```

- [ ] **Step 5: Remove the webUiAuth HTTP check**

Remove/replace the `webUiAuth` check in the HTTP handler (lines 545-559). Replace with:

```typescript
// Auth check for non-API routes
if (!url.pathname.startsWith("/api/auth/") && url.pathname !== "/api/github/webhook") {
  const isSetupNeeded = yield * userService.isSetupRequired;
  if (!isSetupNeeded) {
    const sessionId = getSessionIdFromRequest(req);
    if (!sessionId) {
      // Let the SPA handle redirect to login
      // Only block API/attachment routes
      if (url.pathname.startsWith("/api/") || url.pathname.startsWith(ATTACHMENTS_ROUTE_PREFIX)) {
        respond(
          401,
          { "Content-Type": "application/json" },
          JSON.stringify({ error: "Not authenticated" }),
        );
        return;
      }
    } else {
      const maybeUser = yield * userService.validateSession(sessionId);
      if (
        Option.isNone(maybeUser) &&
        (url.pathname.startsWith("/api/") || url.pathname.startsWith(ATTACHMENTS_ROUTE_PREFIX))
      ) {
        respond(
          401,
          { "Content-Type": "application/json" },
          JSON.stringify({ error: "Session expired" }),
        );
        return;
      }
    }
  }
}
```

- [ ] **Step 6: Add Option to imports if not already there**

Make sure `Option` is imported from effect in wsServer.ts.

- [ ] **Step 7: Run typecheck and lint**

Run: `cd /Users/ryan/Documents/Repos/2026-03-31-t3-opencode && bun typecheck && bun lint`
Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add apps/server/src/wsServer.ts
git commit -m "feat(server): add HTTP auth endpoints and cookie-based session auth"
```

---

## Task 8: Thread Assignment in Contracts & Server

**Files:**

- Modify: `packages/contracts/src/orchestration.ts`
- Modify: `apps/server/src/persistence/Services/ProjectionThreads.ts`
- Modify: `apps/server/src/persistence/Layers/ProjectionThreads.ts`

- [ ] **Step 1: Add assignedUserId to OrchestrationThread schema**

In `packages/contracts/src/orchestration.ts`, add to the `OrchestrationThread` struct (after `archivedAt` line 320):

```typescript
  assignedUserId: Schema.NullOr(Schema.String).pipe(Schema.withDecodingDefault(() => null)),
```

- [ ] **Step 2: Add assignedUserId to ProjectionThread service schema**

Read `apps/server/src/persistence/Services/ProjectionThreads.ts` and add `assignedUserId` to the `ProjectionThread` schema struct:

```typescript
  assignedUserId: Schema.NullOr(Schema.String),
```

- [ ] **Step 3: Update ProjectionThreads layer SQL queries**

In `apps/server/src/persistence/Layers/ProjectionThreads.ts`, add `assigned_user_id` to all SELECT, INSERT, and UPDATE queries. Include the column alias:

In SELECT queries add: `assigned_user_id AS "assignedUserId"`
In INSERT add the column and value.
In UPSERT's ON CONFLICT add: `assigned_user_id = excluded.assigned_user_id`

- [ ] **Step 4: Run typecheck**

Run: `cd /Users/ryan/Documents/Repos/2026-03-31-t3-opencode && bun typecheck`
Expected: PASS — may need to update snapshot query and other consumers of ProjectionThread

- [ ] **Step 5: Commit**

```bash
git add packages/contracts/src/orchestration.ts apps/server/src/persistence/Services/ProjectionThreads.ts apps/server/src/persistence/Layers/ProjectionThreads.ts
git commit -m "feat: add assignedUserId to thread schema and persistence layer"
```

---

## Task 9: Web App Auth Store & API Client

**Files:**

- Create: `apps/web/src/authStore.ts`
- Create: `apps/web/src/lib/authApi.ts`

- [ ] **Step 1: Create auth API client**

Create `apps/web/src/lib/authApi.ts`:

```typescript
import type { User } from "@t3tools/contracts";

function resolveApiBase(): string {
  if (typeof window === "undefined") return "";
  const envWsUrl = import.meta.env.VITE_WS_URL as string | undefined;
  if (envWsUrl && envWsUrl.length > 0) {
    try {
      const wsUrl = new URL(envWsUrl);
      const protocol = wsUrl.protocol === "wss:" ? "https:" : "http:";
      return `${protocol}//${wsUrl.host}`;
    } catch {
      // fall through
    }
  }
  return window.location.origin;
}

async function fetchJson<T>(path: string, options?: RequestInit): Promise<T> {
  const base = resolveApiBase();
  const res = await fetch(`${base}${path}`, {
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(body.error ?? body.message ?? `HTTP ${res.status}`);
  }
  return res.json();
}

export const authApi = {
  setupRequired: () => fetchJson<{ required: boolean }>("/api/auth/setup-required"),

  setup: (input: { username: string; displayName: string; password: string }) =>
    fetchJson<{ user: User }>("/api/auth/setup", {
      method: "POST",
      body: JSON.stringify(input),
    }),

  login: (input: { username: string; password: string }) =>
    fetchJson<{ user: User }>("/api/auth/login", {
      method: "POST",
      body: JSON.stringify(input),
    }),

  logout: () => fetchJson<{}>("/api/auth/logout", { method: "POST" }),

  me: () => fetchJson<{ user: User }>("/api/auth/me"),

  listUsers: () => fetchJson<{ users: User[] }>("/api/auth/users"),

  createUser: (input: { username: string; displayName: string; password: string; role?: string }) =>
    fetchJson<{ user: User }>("/api/auth/users", {
      method: "POST",
      body: JSON.stringify(input),
    }),

  deleteUser: (userId: string) => fetchJson<{}>(`/api/auth/users/${userId}`, { method: "DELETE" }),
};
```

- [ ] **Step 2: Create auth store**

Create `apps/web/src/authStore.ts`:

```typescript
import type { User } from "@t3tools/contracts";
import { create } from "zustand";
import { authApi } from "./lib/authApi";

export type AuthPhase = "loading" | "setup-required" | "login" | "authenticated";

interface AuthState {
  phase: AuthPhase;
  user: User | null;
  error: string | null;
  checkAuth: () => Promise<void>;
  login: (username: string, password: string) => Promise<void>;
  setup: (username: string, displayName: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  clearError: () => void;
}

export const useAuthStore = create<AuthState>((set) => ({
  phase: "loading",
  user: null,
  error: null,

  checkAuth: async () => {
    try {
      const { required } = await authApi.setupRequired();
      if (required) {
        set({ phase: "setup-required", user: null });
        return;
      }

      const { user } = await authApi.me();
      set({ phase: "authenticated", user, error: null });
    } catch {
      set({ phase: "login", user: null });
    }
  },

  login: async (username, password) => {
    try {
      set({ error: null });
      const { user } = await authApi.login({ username, password });
      set({ phase: "authenticated", user, error: null });
    } catch (e) {
      set({ error: e instanceof Error ? e.message : "Login failed" });
    }
  },

  setup: async (username, displayName, password) => {
    try {
      set({ error: null });
      const { user } = await authApi.setup({ username, displayName, password });
      set({ phase: "authenticated", user, error: null });
    } catch (e) {
      set({ error: e instanceof Error ? e.message : "Setup failed" });
    }
  },

  logout: async () => {
    try {
      await authApi.logout();
    } catch {
      // Ignore logout errors
    }
    set({ phase: "login", user: null, error: null });
  },

  clearError: () => set({ error: null }),
}));
```

- [ ] **Step 3: Run typecheck**

Run: `cd /Users/ryan/Documents/Repos/2026-03-31-t3-opencode && bun typecheck`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/lib/authApi.ts apps/web/src/authStore.ts
git commit -m "feat(web): add auth API client and auth state store"
```

---

## Task 10: Login & Setup Pages

**Files:**

- Create: `apps/web/src/components/auth/LoginForm.tsx`
- Create: `apps/web/src/components/auth/SetupForm.tsx`
- Create: `apps/web/src/components/auth/AuthGuard.tsx`
- Create: `apps/web/src/routes/login.tsx`
- Create: `apps/web/src/routes/setup.tsx`
- Modify: `apps/web/src/routes/__root.tsx`

- [ ] **Step 1: Create LoginForm component**

Create `apps/web/src/components/auth/LoginForm.tsx`:

```tsx
import { useState, type FormEvent } from "react";
import { useAuthStore } from "../../authStore";
import { Button } from "../ui/button";
import { APP_DISPLAY_NAME } from "../../branding";

export function LoginForm() {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const { login, error, clearError } = useAuthStore();
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!username.trim() || !password) return;
    setSubmitting(true);
    await login(username.trim(), password);
    setSubmitting(false);
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="w-full max-w-sm space-y-6">
        <div className="text-center">
          <h1 className="text-2xl font-semibold tracking-tight">{APP_DISPLAY_NAME}</h1>
          <p className="mt-1 text-sm text-muted-foreground">Sign in to continue</p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          {error && (
            <div className="rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-400">
              {error}
            </div>
          )}

          <div className="space-y-1.5">
            <label htmlFor="username" className="text-sm font-medium text-foreground">
              Username
            </label>
            <input
              id="username"
              type="text"
              autoComplete="username"
              autoFocus
              value={username}
              onChange={(e) => {
                setUsername(e.target.value);
                clearError();
              }}
              className="flex h-9 w-full rounded-md border border-border bg-background px-3 py-1 text-sm text-foreground shadow-sm transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              placeholder="Enter username"
            />
          </div>

          <div className="space-y-1.5">
            <label htmlFor="password" className="text-sm font-medium text-foreground">
              Password
            </label>
            <input
              id="password"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => {
                setPassword(e.target.value);
                clearError();
              }}
              className="flex h-9 w-full rounded-md border border-border bg-background px-3 py-1 text-sm text-foreground shadow-sm transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              placeholder="Enter password"
            />
          </div>

          <Button
            type="submit"
            className="w-full"
            disabled={submitting || !username.trim() || !password}
          >
            {submitting ? "Signing in..." : "Sign in"}
          </Button>
        </form>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Create SetupForm component**

Create `apps/web/src/components/auth/SetupForm.tsx`:

```tsx
import { useState, type FormEvent } from "react";
import { useAuthStore } from "../../authStore";
import { Button } from "../ui/button";
import { APP_DISPLAY_NAME } from "../../branding";

export function SetupForm() {
  const [username, setUsername] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const { setup, error, clearError } = useAuthStore();
  const [submitting, setSubmitting] = useState(false);

  const passwordMismatch = confirmPassword.length > 0 && password !== confirmPassword;

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!username.trim() || !displayName.trim() || !password || password !== confirmPassword)
      return;
    setSubmitting(true);
    await setup(username.trim(), displayName.trim(), password);
    setSubmitting(false);
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="w-full max-w-sm space-y-6">
        <div className="text-center">
          <h1 className="text-2xl font-semibold tracking-tight">{APP_DISPLAY_NAME}</h1>
          <p className="mt-1 text-sm text-muted-foreground">Create admin account to get started</p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          {error && (
            <div className="rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-400">
              {error}
            </div>
          )}

          <div className="space-y-1.5">
            <label htmlFor="username" className="text-sm font-medium text-foreground">
              Username
            </label>
            <input
              id="username"
              type="text"
              autoComplete="username"
              autoFocus
              value={username}
              onChange={(e) => {
                setUsername(e.target.value);
                clearError();
              }}
              className="flex h-9 w-full rounded-md border border-border bg-background px-3 py-1 text-sm text-foreground shadow-sm transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              placeholder="Choose a username"
            />
          </div>

          <div className="space-y-1.5">
            <label htmlFor="displayName" className="text-sm font-medium text-foreground">
              Display Name
            </label>
            <input
              id="displayName"
              type="text"
              value={displayName}
              onChange={(e) => {
                setDisplayName(e.target.value);
                clearError();
              }}
              className="flex h-9 w-full rounded-md border border-border bg-background px-3 py-1 text-sm text-foreground shadow-sm transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              placeholder="Your name"
            />
          </div>

          <div className="space-y-1.5">
            <label htmlFor="password" className="text-sm font-medium text-foreground">
              Password
            </label>
            <input
              id="password"
              type="password"
              autoComplete="new-password"
              value={password}
              onChange={(e) => {
                setPassword(e.target.value);
                clearError();
              }}
              className="flex h-9 w-full rounded-md border border-border bg-background px-3 py-1 text-sm text-foreground shadow-sm transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              placeholder="Choose a password"
            />
          </div>

          <div className="space-y-1.5">
            <label htmlFor="confirmPassword" className="text-sm font-medium text-foreground">
              Confirm Password
            </label>
            <input
              id="confirmPassword"
              type="password"
              autoComplete="new-password"
              value={confirmPassword}
              onChange={(e) => {
                setConfirmPassword(e.target.value);
                clearError();
              }}
              className="flex h-9 w-full rounded-md border border-border bg-background px-3 py-1 text-sm text-foreground shadow-sm transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              placeholder="Confirm password"
            />
            {passwordMismatch && <p className="text-xs text-red-400">Passwords don't match</p>}
          </div>

          <Button
            type="submit"
            className="w-full"
            disabled={
              submitting || !username.trim() || !displayName.trim() || !password || passwordMismatch
            }
          >
            {submitting ? "Creating account..." : "Create admin account"}
          </Button>
        </form>
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Create AuthGuard component**

Create `apps/web/src/components/auth/AuthGuard.tsx`:

```tsx
import { useEffect, type ReactNode } from "react";
import { useAuthStore } from "../../authStore";
import { LoginForm } from "./LoginForm";
import { SetupForm } from "./SetupForm";
import { APP_DISPLAY_NAME } from "../../branding";

export function AuthGuard({ children }: { children: ReactNode }) {
  const { phase, checkAuth } = useAuthStore();

  useEffect(() => {
    checkAuth();
  }, [checkAuth]);

  if (phase === "loading") {
    return (
      <div className="flex h-screen items-center justify-center bg-background text-foreground">
        <p className="text-sm text-muted-foreground">Loading {APP_DISPLAY_NAME}...</p>
      </div>
    );
  }

  if (phase === "setup-required") {
    return <SetupForm />;
  }

  if (phase === "login") {
    return <LoginForm />;
  }

  return <>{children}</>;
}
```

- [ ] **Step 4: Wrap \_\_root.tsx with AuthGuard**

In `apps/web/src/routes/__root.tsx`, import and wrap:

Add import:

```typescript
import { AuthGuard } from "../components/auth/AuthGuard";
```

In `RootRouteView`, wrap the entire return with `AuthGuard`:

Replace the function body with:

```tsx
function RootRouteView() {
  return (
    <AuthGuard>
      <RootRouteInner />
    </AuthGuard>
  );
}

function RootRouteInner() {
  if (!readNativeApi()) {
    return (
      <div className="flex h-screen flex-col bg-background text-foreground">
        <div className="flex flex-1 items-center justify-center">
          <p className="text-sm text-muted-foreground">
            Connecting to {APP_DISPLAY_NAME} server...
          </p>
        </div>
      </div>
    );
  }

  return (
    <ToastProvider>
      <AnchoredToastProvider>
        <EventRouter />
        <DesktopProjectBootstrap />
        <AppSidebarLayout>
          <Outlet />
        </AppSidebarLayout>
      </AnchoredToastProvider>
    </ToastProvider>
  );
}
```

- [ ] **Step 5: Run typecheck and lint**

Run: `cd /Users/ryan/Documents/Repos/2026-03-31-t3-opencode && bun typecheck && bun lint`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/components/auth/ apps/web/src/routes/__root.tsx
git commit -m "feat(web): add login, setup pages, and auth guard"
```

---

## Task 11: Thread Assignment in Web App Types & Store

**Files:**

- Modify: `apps/web/src/types.ts`
- Modify: `apps/web/src/store.ts`

- [ ] **Step 1: Add assignedUserId to Thread type**

In `apps/web/src/types.ts`, add to the `Thread` interface (after `worktreePath`):

```typescript
assignedUserId: string | null;
```

- [ ] **Step 2: Update syncServerReadModel in store.ts**

In the `syncServerReadModel` function (around line 244), add to the thread mapping (after `worktreePath`):

```typescript
        assignedUserId: thread.assignedUserId ?? null,
```

- [ ] **Step 3: Run typecheck**

Run: `cd /Users/ryan/Documents/Repos/2026-03-31-t3-opencode && bun typecheck`
Expected: May produce errors in components that spread Thread objects — fix any type errors.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/types.ts apps/web/src/store.ts
git commit -m "feat(web): add assignedUserId to Thread type and store mapping"
```

---

## Task 12: Sidebar User Filter & Thread Badges

**Files:**

- Modify: `apps/web/src/components/Sidebar.tsx`

- [ ] **Step 1: Add user filter state and user list query**

Near the top of the `ThreadSidebar` component (find it by searching for `export default function`), add:

Import the auth store and API:

```typescript
import { useAuthStore } from "../authStore";
import { authApi } from "../lib/authApi";
```

Add state and query inside the component:

```typescript
const currentUser = useAuthStore((s) => s.user);
const [threadUserFilter, setThreadUserFilter] = useState<string | "all" | "mine">("mine");
const { data: usersData } = useQuery({
  queryKey: ["auth", "users"],
  queryFn: () => authApi.listUsers(),
  staleTime: 60_000,
});
const allUsers = usersData?.users ?? [];
```

- [ ] **Step 2: Filter threads by assigned user**

Find where threads are filtered/rendered in the sidebar. Add filtering logic:

```typescript
const filteredThreads = useMemo(() => {
  if (!currentUser) return threads;
  if (threadUserFilter === "all") return threads;
  if (threadUserFilter === "mine") {
    return threads.filter((t) => t.assignedUserId === currentUser.id || t.assignedUserId === null);
  }
  return threads.filter((t) => t.assignedUserId === threadUserFilter);
}, [threads, threadUserFilter, currentUser]);
```

Use `filteredThreads` instead of `threads` in the rendering.

- [ ] **Step 3: Add user filter dropdown in sidebar header**

Add a filter dropdown in the sidebar header area (near where thread sort order is shown):

```tsx
<Menu>
  <MenuTrigger>
    <Button variant="ghost" size="sm" className="gap-1.5 text-xs text-muted-foreground">
      <UserIcon className="size-3" />
      {threadUserFilter === "mine"
        ? "My Threads"
        : threadUserFilter === "all"
          ? "All Threads"
          : (allUsers.find((u) => u.id === threadUserFilter)?.displayName ?? "User")}
    </Button>
  </MenuTrigger>
  <MenuPopup>
    <MenuRadioGroup value={threadUserFilter} onValueChange={setThreadUserFilter}>
      <MenuRadioItem value="mine">My Threads</MenuRadioItem>
      <MenuRadioItem value="all">All Threads</MenuRadioItem>
      {allUsers.map((user) => (
        <MenuRadioItem key={user.id} value={user.id}>
          {user.displayName}
        </MenuRadioItem>
      ))}
    </MenuRadioGroup>
  </MenuPopup>
</Menu>
```

Import `UserIcon` from lucide-react.

- [ ] **Step 4: Add user badge on thread items**

In the thread item rendering, add a small badge showing the assigned user:

```tsx
{
  thread.assignedUserId && thread.assignedUserId !== currentUser?.id && (
    <span className="ml-auto text-[10px] text-muted-foreground/50">
      {allUsers
        .find((u) => u.id === thread.assignedUserId)
        ?.displayName?.charAt(0)
        ?.toUpperCase() ?? "?"}
    </span>
  );
}
```

- [ ] **Step 5: Add logout button to sidebar footer**

In the `SidebarFooter` (around line 2244), add a current user indicator and logout button before the settings button:

```tsx
<SidebarMenuItem>
  <SidebarMenuButton
    size="sm"
    className="gap-2 px-2 py-1.5 text-muted-foreground/70 hover:bg-accent hover:text-foreground"
    onClick={() => {
      useAuthStore.getState().logout();
    }}
  >
    <LogOutIcon className="size-3.5" />
    <span className="text-xs">{currentUser?.displayName ?? "User"}</span>
  </SidebarMenuButton>
</SidebarMenuItem>
```

Import `LogOutIcon` from lucide-react.

- [ ] **Step 6: Run typecheck, lint, fmt**

Run: `cd /Users/ryan/Documents/Repos/2026-03-31-t3-opencode && bun fmt && bun lint && bun typecheck`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/components/Sidebar.tsx
git commit -m "feat(web): add thread user filter and user badge in sidebar"
```

---

## Task 13: Thread Assignment Dropdown in Chat Header

**Files:**

- Create: `apps/web/src/components/ThreadAssignmentDropdown.tsx`
- Modify: `apps/web/src/components/chat/ChatHeader.tsx`

- [ ] **Step 1: Create ThreadAssignmentDropdown component**

Create `apps/web/src/components/ThreadAssignmentDropdown.tsx`:

```tsx
import { useQuery } from "@tanstack/react-query";
import { UserIcon } from "lucide-react";
import type { ThreadId } from "@t3tools/contracts";
import { authApi } from "../lib/authApi";
import { readNativeApi } from "../nativeApi";
import { Menu, MenuGroup, MenuPopup, MenuRadioGroup, MenuRadioItem, MenuTrigger } from "./ui/menu";
import { Button } from "./ui/button";

interface ThreadAssignmentDropdownProps {
  threadId: ThreadId;
  assignedUserId: string | null;
}

export function ThreadAssignmentDropdown({
  threadId,
  assignedUserId,
}: ThreadAssignmentDropdownProps) {
  const { data: usersData } = useQuery({
    queryKey: ["auth", "users"],
    queryFn: () => authApi.listUsers(),
    staleTime: 60_000,
  });
  const users = usersData?.users ?? [];
  const assignedUser = users.find((u) => u.id === assignedUserId);

  const handleAssign = (userId: string) => {
    const api = readNativeApi();
    if (!api) return;
    // Dispatch a command to reassign the thread
    // This will be handled via the orchestration command system
    void api.orchestration.dispatchCommand({
      type: "thread.update",
      commandId: crypto.randomUUID() as any,
      threadId,
      assignedUserId: userId === "unassigned" ? null : userId,
    });
  };

  return (
    <Menu>
      <MenuTrigger>
        <Button variant="ghost" size="sm" className="gap-1.5 text-xs text-muted-foreground">
          <UserIcon className="size-3" />
          {assignedUser?.displayName ?? "Unassigned"}
        </Button>
      </MenuTrigger>
      <MenuPopup>
        <MenuRadioGroup value={assignedUserId ?? "unassigned"} onValueChange={handleAssign}>
          <MenuRadioItem value="unassigned">Unassigned</MenuRadioItem>
          {users.map((user) => (
            <MenuRadioItem key={user.id} value={user.id}>
              {user.displayName}
            </MenuRadioItem>
          ))}
        </MenuRadioGroup>
      </MenuPopup>
    </Menu>
  );
}
```

Note: The `thread.update` command may need to be added to the orchestration command system. If this command type doesn't exist, the assignment will need to be done via a direct HTTP API call instead. Adjust the implementation based on the existing command infrastructure.

- [ ] **Step 2: Add dropdown to ChatHeader**

In `apps/web/src/components/chat/ChatHeader.tsx`, import and add the assignment dropdown:

```typescript
import { ThreadAssignmentDropdown } from "../ThreadAssignmentDropdown";
```

Add it in the header bar near the thread title or actions area. The exact placement depends on the current ChatHeader layout — add it alongside existing thread metadata.

- [ ] **Step 3: Run typecheck and lint**

Run: `cd /Users/ryan/Documents/Repos/2026-03-31-t3-opencode && bun typecheck && bun lint`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/components/ThreadAssignmentDropdown.tsx apps/web/src/components/chat/ChatHeader.tsx
git commit -m "feat(web): add thread assignment dropdown in chat header"
```

---

## Task 14: User Management Settings Page

**Files:**

- Create: `apps/web/src/components/settings/UsersPanel.tsx`
- Create: `apps/web/src/routes/settings.users.tsx`
- Modify: `apps/web/src/components/settings/SettingsSidebarNav.tsx`

- [ ] **Step 1: Create UsersPanel component**

Create `apps/web/src/components/settings/UsersPanel.tsx`:

```tsx
import { useState, type FormEvent } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { TrashIcon, PlusIcon } from "lucide-react";
import type { User } from "@t3tools/contracts";
import { authApi } from "../../lib/authApi";
import { useAuthStore } from "../../authStore";
import { Button } from "../ui/button";

export function UsersPanel() {
  const currentUser = useAuthStore((s) => s.user);
  const isAdmin = currentUser?.role === "admin";
  const queryClient = useQueryClient();

  const { data: usersData, isLoading } = useQuery({
    queryKey: ["auth", "users"],
    queryFn: () => authApi.listUsers(),
  });
  const users = usersData?.users ?? [];

  const deleteMutation = useMutation({
    mutationFn: (userId: string) => authApi.deleteUser(userId),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["auth", "users"] }),
  });

  const [showForm, setShowForm] = useState(false);
  const [username, setUsername] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState<"admin" | "member">("member");
  const [formError, setFormError] = useState<string | null>(null);

  const handleCreate = async (e: FormEvent) => {
    e.preventDefault();
    setFormError(null);
    try {
      await authApi.createUser({ username, displayName, password, role });
      queryClient.invalidateQueries({ queryKey: ["auth", "users"] });
      setShowForm(false);
      setUsername("");
      setDisplayName("");
      setPassword("");
      setRole("member");
    } catch (err) {
      setFormError(err instanceof Error ? err.message : "Failed to create user");
    }
  };

  if (isLoading) {
    return <p className="text-sm text-muted-foreground">Loading users...</p>;
  }

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-lg font-medium">Users</h3>
        <p className="text-sm text-muted-foreground">
          {isAdmin ? "Manage user accounts" : "View team members"}
        </p>
      </div>

      <div className="divide-y divide-border rounded-md border">
        {users.map((user) => (
          <div key={user.id} className="flex items-center justify-between px-4 py-3">
            <div>
              <p className="text-sm font-medium">{user.displayName}</p>
              <p className="text-xs text-muted-foreground">
                @{user.username} · {user.role}
              </p>
            </div>
            {isAdmin && user.id !== currentUser?.id && (
              <Button
                variant="ghost"
                size="sm"
                className="text-red-400 hover:text-red-300"
                onClick={() => {
                  if (confirm(`Delete user ${user.displayName}?`)) {
                    deleteMutation.mutate(user.id);
                  }
                }}
              >
                <TrashIcon className="size-3.5" />
              </Button>
            )}
          </div>
        ))}
      </div>

      {isAdmin && !showForm && (
        <Button variant="outline" size="sm" onClick={() => setShowForm(true)} className="gap-1.5">
          <PlusIcon className="size-3.5" />
          Add User
        </Button>
      )}

      {isAdmin && showForm && (
        <form onSubmit={handleCreate} className="space-y-3 rounded-md border p-4">
          {formError && (
            <div className="rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-400">
              {formError}
            </div>
          )}
          <div className="grid grid-cols-2 gap-3">
            <input
              type="text"
              placeholder="Username"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              className="flex h-9 w-full rounded-md border border-border bg-background px-3 py-1 text-sm"
            />
            <input
              type="text"
              placeholder="Display Name"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              className="flex h-9 w-full rounded-md border border-border bg-background px-3 py-1 text-sm"
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <input
              type="password"
              placeholder="Password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="flex h-9 w-full rounded-md border border-border bg-background px-3 py-1 text-sm"
            />
            <select
              value={role}
              onChange={(e) => setRole(e.target.value as "admin" | "member")}
              className="flex h-9 w-full rounded-md border border-border bg-background px-3 py-1 text-sm"
            >
              <option value="member">Member</option>
              <option value="admin">Admin</option>
            </select>
          </div>
          <div className="flex gap-2">
            <Button type="submit" size="sm" disabled={!username || !displayName || !password}>
              Create
            </Button>
            <Button type="button" variant="ghost" size="sm" onClick={() => setShowForm(false)}>
              Cancel
            </Button>
          </div>
        </form>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Create settings.users.tsx route**

Create `apps/web/src/routes/settings.users.tsx`:

```tsx
import { createFileRoute } from "@tanstack/react-router";
import { UsersPanel } from "../components/settings/UsersPanel";

export const Route = createFileRoute("/settings/users")({
  component: UsersPanel,
});
```

- [ ] **Step 3: Add "Users" nav item to SettingsSidebarNav**

In `apps/web/src/components/settings/SettingsSidebarNav.tsx`, add a "Users" link alongside the existing settings nav items (General, Archived). Import `UsersIcon` from lucide-react and add:

```tsx
{ to: "/settings/users", label: "Users", icon: UsersIcon }
```

- [ ] **Step 4: Run typecheck, lint, fmt**

Run: `cd /Users/ryan/Documents/Repos/2026-03-31-t3-opencode && bun fmt && bun lint && bun typecheck`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/settings/UsersPanel.tsx apps/web/src/routes/settings.users.tsx apps/web/src/components/settings/SettingsSidebarNav.tsx
git commit -m "feat(web): add user management settings page"
```

---

## Task 15: Remove Nginx Basic Auth from Docker Compose

**Files:**

- Modify: `docker-compose.yml`

- [ ] **Step 1: Remove basic auth env vars and nginx config**

In `docker-compose.yml`:

1. Remove `T3_WEB_UI_USER` and `T3_WEB_UI_PASSWORD` from the environment block (lines 17-18)
2. Remove the entire basic auth snippet generation in the command (lines 43-51, the `if [ -n "$$WEB_USER" ]` block)
3. Remove `__T3_AUTH_SNIPPET__` from the nginx config template (line 70)
4. Remove `__T3_AUTH_HEADER__` from the `/ws` location block (line 85)
5. Remove the `sed` lines that substitute these placeholders (lines 103-104)
6. Remove `auth_basic off;` from the webhook location

Keep the nginx as a plain TLS reverse proxy.

- [ ] **Step 2: Verify docker-compose is valid**

Run: `cd /Users/ryan/Documents/Repos/2026-03-31-t3-opencode && docker compose config --quiet 2>&1`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add docker-compose.yml
git commit -m "feat(docker): remove nginx basic auth, app handles auth now"
```

---

## Task 16: Remove webUiAuth from Server Config

**Files:**

- Modify: `apps/server/src/config.ts`
- Modify: `apps/server/src/main.ts` (or wherever webUiAuth is set)

- [ ] **Step 1: Remove webUiAuth from ServerConfigShape**

In `apps/server/src/config.ts`, remove the `webUiAuth` property from `ServerConfigShape` (lines 46-51). Also remove `authToken` if desktop mode doesn't need it, or leave it for backward compat.

- [ ] **Step 2: Remove webUiAuth from main.ts**

Find where `webUiAuth` is constructed from env vars and remove it.

- [ ] **Step 3: Clean up wsServer.ts references**

Remove the remaining `webUiAuth` destructuring and any dead code referencing it. Remove the `WEB_UI_AUTH_CHALLENGE_HEADER`, `decodeBasicAuthHeader`, and `hasMatchingWebUiCredentials` functions since they're no longer used.

- [ ] **Step 4: Run typecheck and lint**

Run: `cd /Users/ryan/Documents/Repos/2026-03-31-t3-opencode && bun typecheck && bun lint`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/config.ts apps/server/src/main.ts apps/server/src/wsServer.ts
git commit -m "refactor(server): remove webUiAuth, replaced by app-level cookie auth"
```

---

## Task 17: Final Integration Check

**Files:** All modified files

- [ ] **Step 1: Run full check suite**

```bash
cd /Users/ryan/Documents/Repos/2026-03-31-t3-opencode
bun fmt
bun lint
bun typecheck
```

Expected: All pass

- [ ] **Step 2: Run tests**

```bash
cd /Users/ryan/Documents/Repos/2026-03-31-t3-opencode
bun run test
```

Expected: All existing tests pass. New UserRepository test passes.

- [ ] **Step 3: Manual smoke test**

1. Start the dev server: `bun dev:server`
2. Start the web app: `bun dev:web`
3. Open the app — should see the setup form
4. Create admin account
5. Verify auto-login and redirect to main app
6. Open settings → Users tab
7. Create a second user
8. Logout, login as the second user
9. Create a thread — verify it appears in sidebar
10. Switch thread filter to "All Threads" / specific user

- [ ] **Step 4: Commit any fixes**

```bash
git add -A
git commit -m "fix: address integration issues from user accounts feature"
```
