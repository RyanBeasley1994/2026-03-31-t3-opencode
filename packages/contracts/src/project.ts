import { Schema } from "effect";
import { PositiveInt, TrimmedNonEmptyString } from "./baseSchemas";

const PROJECT_SEARCH_ENTRIES_MAX_LIMIT = 200;
const PROJECT_WRITE_FILE_PATH_MAX_LENGTH = 512;
const PROJECT_GITHUB_REPOSITORY_MAX_LIMIT = 200;
const PROJECT_GITHUB_REPOSITORY_QUERY_MAX_LENGTH = 120;
const PROJECT_GITHUB_REPOSITORY_NAME_MAX_LENGTH = 256;
const PROJECT_CLONE_DESTINATION_PATH_MAX_LENGTH = 1024;

export const ProjectSearchEntriesInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  query: TrimmedNonEmptyString.check(Schema.isMaxLength(256)),
  limit: PositiveInt.check(Schema.isLessThanOrEqualTo(PROJECT_SEARCH_ENTRIES_MAX_LIMIT)),
});
export type ProjectSearchEntriesInput = typeof ProjectSearchEntriesInput.Type;

const ProjectEntryKind = Schema.Literals(["file", "directory"]);

export const ProjectEntry = Schema.Struct({
  path: TrimmedNonEmptyString,
  kind: ProjectEntryKind,
  parentPath: Schema.optional(TrimmedNonEmptyString),
});
export type ProjectEntry = typeof ProjectEntry.Type;

export const ProjectSearchEntriesResult = Schema.Struct({
  entries: Schema.Array(ProjectEntry),
  truncated: Schema.Boolean,
});
export type ProjectSearchEntriesResult = typeof ProjectSearchEntriesResult.Type;

export const ProjectWriteFileInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  relativePath: TrimmedNonEmptyString.check(Schema.isMaxLength(PROJECT_WRITE_FILE_PATH_MAX_LENGTH)),
  contents: Schema.String,
});
export type ProjectWriteFileInput = typeof ProjectWriteFileInput.Type;

export const ProjectWriteFileResult = Schema.Struct({
  relativePath: TrimmedNonEmptyString,
});
export type ProjectWriteFileResult = typeof ProjectWriteFileResult.Type;

export const ProjectListGithubRepositoriesInput = Schema.Struct({
  query: Schema.optional(
    TrimmedNonEmptyString.check(Schema.isMaxLength(PROJECT_GITHUB_REPOSITORY_QUERY_MAX_LENGTH)),
  ),
  limit: Schema.optional(
    PositiveInt.check(Schema.isLessThanOrEqualTo(PROJECT_GITHUB_REPOSITORY_MAX_LIMIT)),
  ),
});
export type ProjectListGithubRepositoriesInput = typeof ProjectListGithubRepositoriesInput.Type;

export const ProjectGithubRepositoryVisibility = Schema.Literals(["public", "private"]);
export type ProjectGithubRepositoryVisibility = typeof ProjectGithubRepositoryVisibility.Type;

export const ProjectGithubRepository = Schema.Struct({
  nameWithOwner: TrimmedNonEmptyString.check(
    Schema.isMaxLength(PROJECT_GITHUB_REPOSITORY_NAME_MAX_LENGTH),
  ),
  description: Schema.NullOr(Schema.String),
  url: TrimmedNonEmptyString,
  sshUrl: TrimmedNonEmptyString,
  visibility: ProjectGithubRepositoryVisibility,
});
export type ProjectGithubRepository = typeof ProjectGithubRepository.Type;

export const ProjectListGithubRepositoriesResult = Schema.Struct({
  repositories: Schema.Array(ProjectGithubRepository),
});
export type ProjectListGithubRepositoriesResult = typeof ProjectListGithubRepositoriesResult.Type;

export const ProjectCloneGithubRepositoryInput = Schema.Struct({
  repository: TrimmedNonEmptyString.check(
    Schema.isMaxLength(PROJECT_GITHUB_REPOSITORY_NAME_MAX_LENGTH),
  ),
  destinationPath: TrimmedNonEmptyString.check(
    Schema.isMaxLength(PROJECT_CLONE_DESTINATION_PATH_MAX_LENGTH),
  ),
});
export type ProjectCloneGithubRepositoryInput = typeof ProjectCloneGithubRepositoryInput.Type;

export const ProjectCloneGithubRepositoryResult = Schema.Struct({
  workspaceRoot: TrimmedNonEmptyString,
});
export type ProjectCloneGithubRepositoryResult = typeof ProjectCloneGithubRepositoryResult.Type;
