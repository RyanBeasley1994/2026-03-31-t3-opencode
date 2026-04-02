import { Schema, ServiceMap } from "effect";
import type { Effect, Option } from "effect";
import type { User, UserId } from "@t3tools/contracts";

export class AuthError extends Schema.TaggedErrorClass<AuthError>()("AuthError", {
  reason: Schema.Literals([
    "invalid_credentials",
    "user_exists",
    "not_found",
    "not_admin",
    "setup_already_done",
  ] as const),
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
