import { Effect, Layer, Schema } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import { toPersistenceDecodeError, toPersistenceSqlError } from "../Errors.ts";
import {
  GithubWorktreeCleanupJobEnqueueInput,
  GithubWorktreeCleanupJobRecord,
  GithubWorktreeCleanupJobRepository,
  type GithubWorktreeCleanupJobRepositoryShape,
} from "../Services/GithubWorktreeCleanupJobs.ts";

const decodeCleanupJobSync = Schema.decodeUnknownSync(GithubWorktreeCleanupJobRecord);
const decodeCleanupJob = (row: unknown) =>
  Effect.try({
    try: () => decodeCleanupJobSync(row),
    catch: (cause) =>
      toPersistenceDecodeError("GithubWorktreeCleanupJobRepository.decode")(cause as any),
  });

const makeGithubWorktreeCleanupJobRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const enqueueJob = SqlSchema.findOne({
    Request: GithubWorktreeCleanupJobEnqueueInput,
    Result: GithubWorktreeCleanupJobRecord,
    execute: (input) =>
      sql`
        INSERT INTO github_worktree_cleanup_jobs (
          worktree_path,
          project_id,
          thread_id,
          repo_owner,
          repo_name,
          pr_number,
          issue_number,
          installation_id,
          attempt_count,
          next_attempt_at,
          status,
          last_error,
          created_at,
          updated_at,
          completed_at
        )
        VALUES (
          ${input.worktreePath},
          ${input.projectId},
          ${input.threadId},
          ${input.repoOwner},
          ${input.repoName},
          ${input.prNumber},
          ${input.issueNumber},
          ${input.installationId},
          0,
          ${input.nextAttemptAt},
          'pending',
          NULL,
          ${input.createdAt},
          ${input.updatedAt},
          NULL
        )
        RETURNING
          id AS "id",
          worktree_path AS "worktreePath",
          project_id AS "projectId",
          thread_id AS "threadId",
          repo_owner AS "repoOwner",
          repo_name AS "repoName",
          pr_number AS "prNumber",
          issue_number AS "issueNumber",
          installation_id AS "installationId",
          attempt_count AS "attemptCount",
          next_attempt_at AS "nextAttemptAt",
          status,
          last_error AS "lastError",
          created_at AS "createdAt",
          updated_at AS "updatedAt",
          completed_at AS "completedAt"
      `,
  });

  const listDuePendingJobs = SqlSchema.findAll({
    Request: Schema.Struct({
      now: Schema.String,
      limit: Schema.Number,
    }),
    Result: GithubWorktreeCleanupJobRecord,
    execute: (input) =>
      sql`
        SELECT
          id AS "id",
          worktree_path AS "worktreePath",
          project_id AS "projectId",
          thread_id AS "threadId",
          repo_owner AS "repoOwner",
          repo_name AS "repoName",
          pr_number AS "prNumber",
          issue_number AS "issueNumber",
          installation_id AS "installationId",
          attempt_count AS "attemptCount",
          next_attempt_at AS "nextAttemptAt",
          status,
          last_error AS "lastError",
          created_at AS "createdAt",
          updated_at AS "updatedAt",
          completed_at AS "completedAt"
        FROM github_worktree_cleanup_jobs
        WHERE status = 'pending' AND next_attempt_at <= ${input.now}
        ORDER BY next_attempt_at ASC, id ASC
        LIMIT ${input.limit}
      `,
  });

  const markSucceededJob = SqlSchema.void({
    Request: Schema.Struct({
      id: Schema.Number,
      completedAt: Schema.String,
      updatedAt: Schema.String,
    }),
    execute: (input) =>
      sql`
        UPDATE github_worktree_cleanup_jobs
        SET
          status = 'succeeded',
          completed_at = ${input.completedAt},
          updated_at = ${input.updatedAt},
          last_error = NULL
        WHERE id = ${input.id}
      `,
  });

  const markRetryJob = SqlSchema.void({
    Request: Schema.Struct({
      id: Schema.Number,
      attemptCount: Schema.Number,
      nextAttemptAt: Schema.String,
      lastError: Schema.String,
      updatedAt: Schema.String,
    }),
    execute: (input) =>
      sql`
        UPDATE github_worktree_cleanup_jobs
        SET
          status = 'pending',
          attempt_count = ${input.attemptCount},
          next_attempt_at = ${input.nextAttemptAt},
          last_error = ${input.lastError},
          updated_at = ${input.updatedAt}
        WHERE id = ${input.id}
      `,
  });

  const markFailedJob = SqlSchema.void({
    Request: Schema.Struct({
      id: Schema.Number,
      attemptCount: Schema.Number,
      lastError: Schema.String,
      completedAt: Schema.String,
      updatedAt: Schema.String,
    }),
    execute: (input) =>
      sql`
        UPDATE github_worktree_cleanup_jobs
        SET
          status = 'failed',
          attempt_count = ${input.attemptCount},
          last_error = ${input.lastError},
          completed_at = ${input.completedAt},
          updated_at = ${input.updatedAt}
        WHERE id = ${input.id}
      `,
  });

  const enqueue: GithubWorktreeCleanupJobRepositoryShape["enqueue"] = (input) =>
    enqueueJob(input).pipe(
      Effect.mapError(toPersistenceSqlError("GithubWorktreeCleanupJobRepository.enqueue:query")),
      Effect.flatMap((row) => decodeCleanupJob(row)),
    );

  const listDuePending: GithubWorktreeCleanupJobRepositoryShape["listDuePending"] = (input) =>
    listDuePendingJobs(input).pipe(
      Effect.mapError(
        toPersistenceSqlError("GithubWorktreeCleanupJobRepository.listDuePending:query"),
      ),
      Effect.flatMap((rows) => Effect.forEach(rows, (row) => decodeCleanupJob(row))),
    );

  const markSucceeded: GithubWorktreeCleanupJobRepositoryShape["markSucceeded"] = (input) =>
    markSucceededJob(input).pipe(
      Effect.mapError(
        toPersistenceSqlError("GithubWorktreeCleanupJobRepository.markSucceeded:query"),
      ),
    );

  const markRetry: GithubWorktreeCleanupJobRepositoryShape["markRetry"] = (input) =>
    markRetryJob(input).pipe(
      Effect.mapError(toPersistenceSqlError("GithubWorktreeCleanupJobRepository.markRetry:query")),
    );

  const markFailed: GithubWorktreeCleanupJobRepositoryShape["markFailed"] = (input) =>
    markFailedJob(input).pipe(
      Effect.mapError(toPersistenceSqlError("GithubWorktreeCleanupJobRepository.markFailed:query")),
    );

  return {
    enqueue,
    listDuePending,
    markSucceeded,
    markRetry,
    markFailed,
  } satisfies GithubWorktreeCleanupJobRepositoryShape;
});

export const GithubWorktreeCleanupJobRepositoryLive = Layer.effect(
  GithubWorktreeCleanupJobRepository,
  makeGithubWorktreeCleanupJobRepository,
);
