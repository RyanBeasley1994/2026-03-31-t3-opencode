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
  readonly getById: (input: GetSessionInput) => Effect.Effect<Option.Option<UserSession>, ProjectionRepositoryError>;
  readonly deleteById: (input: DeleteSessionInput) => Effect.Effect<void, ProjectionRepositoryError>;
  readonly deleteByUserId: (input: DeleteUserSessionsInput) => Effect.Effect<void, ProjectionRepositoryError>;
  readonly deleteExpired: () => Effect.Effect<void, ProjectionRepositoryError>;
}

export class UserSessionRepository extends ServiceMap.Service<
  UserSessionRepository,
  UserSessionRepositoryShape
>()("t3/persistence/Services/UserSessions/UserSessionRepository") {}
