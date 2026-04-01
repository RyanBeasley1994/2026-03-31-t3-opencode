import {
  IsoDateTime,
  NonNegativeInt,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import { Schema, ServiceMap } from "effect";
import type { Effect } from "effect";
import type { ProjectionRepositoryError } from "../Errors.ts";

export const GithubWorktreeCleanupJobStatus = Schema.Literals(["pending", "succeeded", "failed"]);
export type GithubWorktreeCleanupJobStatus = typeof GithubWorktreeCleanupJobStatus.Type;

export const GithubWorktreeCleanupJobRecord = Schema.Struct({
  id: NonNegativeInt,
  worktreePath: TrimmedNonEmptyString,
  projectId: ProjectId,
  threadId: ThreadId,
  repoOwner: TrimmedNonEmptyString,
  repoName: TrimmedNonEmptyString,
  prNumber: Schema.NullOr(NonNegativeInt),
  issueNumber: Schema.NullOr(NonNegativeInt),
  installationId: NonNegativeInt,
  attemptCount: NonNegativeInt,
  nextAttemptAt: IsoDateTime,
  status: GithubWorktreeCleanupJobStatus,
  lastError: Schema.NullOr(Schema.String),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  completedAt: Schema.NullOr(IsoDateTime),
});
export type GithubWorktreeCleanupJobRecord = typeof GithubWorktreeCleanupJobRecord.Type;

export const GithubWorktreeCleanupJobEnqueueInput = Schema.Struct({
  worktreePath: TrimmedNonEmptyString,
  projectId: ProjectId,
  threadId: ThreadId,
  repoOwner: TrimmedNonEmptyString,
  repoName: TrimmedNonEmptyString,
  prNumber: Schema.NullOr(NonNegativeInt),
  issueNumber: Schema.NullOr(NonNegativeInt),
  installationId: NonNegativeInt,
  nextAttemptAt: IsoDateTime,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type GithubWorktreeCleanupJobEnqueueInput = typeof GithubWorktreeCleanupJobEnqueueInput.Type;

export interface GithubWorktreeCleanupJobRepositoryShape {
  readonly enqueue: (
    input: GithubWorktreeCleanupJobEnqueueInput,
  ) => Effect.Effect<GithubWorktreeCleanupJobRecord, ProjectionRepositoryError>;
  readonly listDuePending: (input: {
    now: string;
    limit: number;
  }) => Effect.Effect<ReadonlyArray<GithubWorktreeCleanupJobRecord>, ProjectionRepositoryError>;
  readonly markSucceeded: (input: {
    id: number;
    completedAt: string;
    updatedAt: string;
  }) => Effect.Effect<void, ProjectionRepositoryError>;
  readonly markRetry: (input: {
    id: number;
    attemptCount: number;
    nextAttemptAt: string;
    lastError: string;
    updatedAt: string;
  }) => Effect.Effect<void, ProjectionRepositoryError>;
  readonly markFailed: (input: {
    id: number;
    attemptCount: number;
    lastError: string;
    completedAt: string;
    updatedAt: string;
  }) => Effect.Effect<void, ProjectionRepositoryError>;
}

export class GithubWorktreeCleanupJobRepository extends ServiceMap.Service<
  GithubWorktreeCleanupJobRepository,
  GithubWorktreeCleanupJobRepositoryShape
>()("t3/persistence/Services/GithubWorktreeCleanupJobs/GithubWorktreeCleanupJobRepository") {}
