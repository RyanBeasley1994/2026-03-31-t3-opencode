import { Schema } from "effect";
import { IsoDateTime, TrimmedNonEmptyString, UserId } from "./baseSchemas";

export const UserRole = Schema.Literals(["admin", "member"] as const);
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
  role: UserRole.pipe(Schema.withDecodingDefaultKey(() => "member" as const)),
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
