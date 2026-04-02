import { UserId, IsoDateTime } from "@t3tools/contracts";
import { Option, Schema, ServiceMap } from "effect";
import type { Effect } from "effect";
import type { ProjectionRepositoryError } from "../Errors.ts";

export const ProjectionUser = Schema.Struct({
  userId: UserId,
  username: Schema.String,
  displayName: Schema.String,
  passwordHash: Schema.String,
  role: Schema.Literals(["admin", "member"] as const),
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
