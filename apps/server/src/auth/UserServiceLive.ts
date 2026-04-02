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

function mapRepoError(reason: AuthError["reason"], message: string) {
  return () => new AuthError({ reason, message });
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
      const count = yield* userRepo
        .count()
        .pipe(Effect.mapError(mapRepoError("not_found", "Failed to query users")));
      if (count > 0) {
        return yield* new AuthError({
          reason: "setup_already_done",
          message: "Admin account already exists",
        });
      }

      const userId = generateId() as UserId;
      const now = new Date().toISOString();
      const passwordHash = yield* Effect.promise(() => hash(input.password));

      yield* userRepo
        .upsert({
          userId,
          username: input.username,
          displayName: input.displayName,
          passwordHash,
          role: "admin",
          createdAt: now,
        })
        .pipe(Effect.mapError(mapRepoError("not_found", "Failed to create user")));

      const sessionId = generateId();
      const expiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString();
      yield* sessionRepo
        .create({
          sessionId: sessionId as any,
          userId,
          createdAt: now,
          expiresAt,
        })
        .pipe(Effect.mapError(mapRepoError("not_found", "Failed to create session")));

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
      const maybeUser = yield* userRepo
        .getByUsername({ username: input.username })
        .pipe(Effect.mapError(mapRepoError("invalid_credentials", "Failed to query user")));
      if (Option.isNone(maybeUser)) {
        return yield* new AuthError({
          reason: "invalid_credentials",
          message: "Invalid username or password",
        });
      }
      const user = maybeUser.value;

      const valid: boolean = yield* Effect.promise(() => verify(user.passwordHash, input.password));
      if (!valid) {
        return yield* new AuthError({
          reason: "invalid_credentials",
          message: "Invalid username or password",
        });
      }

      const sessionId = generateId();
      const now = new Date().toISOString();
      const expiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString();
      yield* sessionRepo
        .create({
          sessionId: sessionId as any,
          userId: user.userId,
          createdAt: now,
          expiresAt,
        })
        .pipe(Effect.mapError(mapRepoError("not_found", "Failed to create session")));

      yield* sessionRepo.deleteExpired().pipe(Effect.ignore({ log: true }));

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
        yield* sessionRepo
          .deleteById({ sessionId: sessionId as any })
          .pipe(Effect.ignore({ log: true }));
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

      const existing = yield* userRepo
        .getByUsername({ username: input.username })
        .pipe(Effect.mapError(mapRepoError("not_found", "Failed to query user")));
      if (Option.isSome(existing)) {
        return yield* new AuthError({ reason: "user_exists", message: "Username already taken" });
      }

      const userId = generateId() as UserId;
      const now = new Date().toISOString();
      const passwordHash = yield* Effect.promise(() => hash(input.password));

      yield* userRepo
        .upsert({
          userId,
          username: input.username,
          displayName: input.displayName,
          passwordHash,
          role: input.role,
          createdAt: now,
        })
        .pipe(Effect.mapError(mapRepoError("not_found", "Failed to create user")));

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

      yield* sessionRepo
        .deleteByUserId({ userId: input.userId })
        .pipe(Effect.mapError(mapRepoError("not_found", "Failed to delete user sessions")));
      yield* userRepo
        .deleteById({ userId: input.userId })
        .pipe(Effect.mapError(mapRepoError("not_found", "Failed to delete user")));
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
