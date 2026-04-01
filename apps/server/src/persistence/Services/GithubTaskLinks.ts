import {
  IsoDateTime,
  NonNegativeInt,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import { Option, Schema, ServiceMap } from "effect";
import type { Effect } from "effect";
import type { ProjectionRepositoryError } from "../Errors.ts";

export const GithubTaskLinkSourceType = Schema.Literals(["issue", "pr"]);
export type GithubTaskLinkSourceType = typeof GithubTaskLinkSourceType.Type;

export const GithubTaskLinkRecord = Schema.Struct({
  id: NonNegativeInt,
  repoOwner: TrimmedNonEmptyString,
  repoName: TrimmedNonEmptyString,
  sourceType: GithubTaskLinkSourceType,
  sourceNumber: NonNegativeInt,
  prNumber: Schema.NullOr(NonNegativeInt),
  sourceBranch: Schema.NullOr(TrimmedNonEmptyString),
  threadId: ThreadId,
  projectId: ProjectId,
  isActive: Schema.Boolean,
  archivedAt: Schema.NullOr(IsoDateTime),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type GithubTaskLinkRecord = typeof GithubTaskLinkRecord.Type;

export const GithubTaskLinkInsertInput = Schema.Struct({
  repoOwner: TrimmedNonEmptyString,
  repoName: TrimmedNonEmptyString,
  sourceType: GithubTaskLinkSourceType,
  sourceNumber: NonNegativeInt,
  prNumber: Schema.NullOr(NonNegativeInt),
  sourceBranch: Schema.NullOr(TrimmedNonEmptyString),
  threadId: ThreadId,
  projectId: ProjectId,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type GithubTaskLinkInsertInput = typeof GithubTaskLinkInsertInput.Type;

export const GithubTaskLinkSourceLookup = Schema.Struct({
  repoOwner: TrimmedNonEmptyString,
  repoName: TrimmedNonEmptyString,
  sourceType: GithubTaskLinkSourceType,
  sourceNumber: NonNegativeInt,
});
export type GithubTaskLinkSourceLookup = typeof GithubTaskLinkSourceLookup.Type;

export const GithubTaskLinkPrLookup = Schema.Struct({
  repoOwner: TrimmedNonEmptyString,
  repoName: TrimmedNonEmptyString,
  prNumber: NonNegativeInt,
});
export type GithubTaskLinkPrLookup = typeof GithubTaskLinkPrLookup.Type;

export interface GithubTaskLinkRepositoryShape {
  readonly insert: (
    input: GithubTaskLinkInsertInput,
  ) => Effect.Effect<GithubTaskLinkRecord, ProjectionRepositoryError>;
  readonly findActiveBySource: (
    input: GithubTaskLinkSourceLookup,
  ) => Effect.Effect<Option.Option<GithubTaskLinkRecord>, ProjectionRepositoryError>;
  readonly listActiveByPr: (
    input: GithubTaskLinkPrLookup,
  ) => Effect.Effect<ReadonlyArray<GithubTaskLinkRecord>, ProjectionRepositoryError>;
  readonly listActiveIssueLinksWithoutPr: (input: {
    repoOwner: string;
    repoName: string;
  }) => Effect.Effect<ReadonlyArray<GithubTaskLinkRecord>, ProjectionRepositoryError>;
  readonly attachPrToLink: (input: {
    id: number;
    prNumber: number;
    updatedAt: string;
  }) => Effect.Effect<void, ProjectionRepositoryError>;
  readonly archiveLink: (input: {
    id: number;
    archivedAt: string;
    updatedAt: string;
  }) => Effect.Effect<void, ProjectionRepositoryError>;
}

export class GithubTaskLinkRepository extends ServiceMap.Service<
  GithubTaskLinkRepository,
  GithubTaskLinkRepositoryShape
>()("t3/persistence/Services/GithubTaskLinks/GithubTaskLinkRepository") {}
