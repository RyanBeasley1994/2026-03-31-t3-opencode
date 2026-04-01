import { Effect, Layer, Option, Schema } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import { toPersistenceDecodeError, toPersistenceSqlError } from "../Errors.ts";
import {
  GithubTaskLinkInsertInput,
  GithubTaskLinkPrLookup,
  GithubTaskLinkRecord,
  GithubTaskLinkRepository,
  type GithubTaskLinkRepositoryShape,
  GithubTaskLinkSourceLookup,
} from "../Services/GithubTaskLinks.ts";

const GithubTaskLinkDbRow = Schema.Struct({
  id: Schema.Number,
  repoOwner: Schema.String,
  repoName: Schema.String,
  sourceType: Schema.String,
  sourceNumber: Schema.Number,
  prNumber: Schema.NullOr(Schema.Number),
  sourceBranch: Schema.NullOr(Schema.String),
  threadId: Schema.String,
  projectId: Schema.String,
  isActive: Schema.Number,
  archivedAt: Schema.NullOr(Schema.String),
  createdAt: Schema.String,
  updatedAt: Schema.String,
});
type GithubTaskLinkDbRow = typeof GithubTaskLinkDbRow.Type;

const decodeTaskLinkSync = Schema.decodeUnknownSync(GithubTaskLinkRecord);
const decodeTaskLink = (row: unknown) =>
  Effect.try({
    try: () => decodeTaskLinkSync(row),
    catch: (cause) => toPersistenceDecodeError("GithubTaskLinkRepository.decode")(cause as any),
  });

const makeGithubTaskLinkRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const insertTaskLink = SqlSchema.findOne({
    Request: GithubTaskLinkInsertInput,
    Result: GithubTaskLinkDbRow,
    execute: (input) =>
      sql`
        INSERT INTO github_task_links (
          repo_owner,
          repo_name,
          source_type,
          source_number,
          pr_number,
          source_branch,
          thread_id,
          project_id,
          is_active,
          archived_at,
          created_at,
          updated_at
        )
        VALUES (
          ${input.repoOwner},
          ${input.repoName},
          ${input.sourceType},
          ${input.sourceNumber},
          ${input.prNumber},
          ${input.sourceBranch},
          ${input.threadId},
          ${input.projectId},
          1,
          NULL,
          ${input.createdAt},
          ${input.updatedAt}
        )
        RETURNING
          id AS "id",
          repo_owner AS "repoOwner",
          repo_name AS "repoName",
          source_type AS "sourceType",
          source_number AS "sourceNumber",
          pr_number AS "prNumber",
          source_branch AS "sourceBranch",
          thread_id AS "threadId",
          project_id AS "projectId",
          is_active AS "isActive",
          archived_at AS "archivedAt",
          created_at AS "createdAt",
          updated_at AS "updatedAt"
      `,
  });

  const findActiveBySourceRow = SqlSchema.findOneOption({
    Request: GithubTaskLinkSourceLookup,
    Result: GithubTaskLinkDbRow,
    execute: (input) =>
      sql`
        SELECT
          id AS "id",
          repo_owner AS "repoOwner",
          repo_name AS "repoName",
          source_type AS "sourceType",
          source_number AS "sourceNumber",
          pr_number AS "prNumber",
          source_branch AS "sourceBranch",
          thread_id AS "threadId",
          project_id AS "projectId",
          is_active AS "isActive",
          archived_at AS "archivedAt",
          created_at AS "createdAt",
          updated_at AS "updatedAt"
        FROM github_task_links
        WHERE
          repo_owner = ${input.repoOwner}
          AND repo_name = ${input.repoName}
          AND source_type = ${input.sourceType}
          AND source_number = ${input.sourceNumber}
          AND is_active = 1
        ORDER BY created_at ASC, id ASC
        LIMIT 1
      `,
  });

  const listActiveByPrRows = SqlSchema.findAll({
    Request: GithubTaskLinkPrLookup,
    Result: GithubTaskLinkDbRow,
    execute: (input) =>
      sql`
        SELECT
          id AS "id",
          repo_owner AS "repoOwner",
          repo_name AS "repoName",
          source_type AS "sourceType",
          source_number AS "sourceNumber",
          pr_number AS "prNumber",
          source_branch AS "sourceBranch",
          thread_id AS "threadId",
          project_id AS "projectId",
          is_active AS "isActive",
          archived_at AS "archivedAt",
          created_at AS "createdAt",
          updated_at AS "updatedAt"
        FROM github_task_links
        WHERE
          repo_owner = ${input.repoOwner}
          AND repo_name = ${input.repoName}
          AND pr_number = ${input.prNumber}
          AND is_active = 1
        ORDER BY created_at ASC, id ASC
      `,
  });

  const listActiveIssueLinksWithoutPrRows = SqlSchema.findAll({
    Request: Schema.Struct({
      repoOwner: Schema.String,
      repoName: Schema.String,
    }),
    Result: GithubTaskLinkDbRow,
    execute: (input) =>
      sql`
        SELECT
          id AS "id",
          repo_owner AS "repoOwner",
          repo_name AS "repoName",
          source_type AS "sourceType",
          source_number AS "sourceNumber",
          pr_number AS "prNumber",
          source_branch AS "sourceBranch",
          thread_id AS "threadId",
          project_id AS "projectId",
          is_active AS "isActive",
          archived_at AS "archivedAt",
          created_at AS "createdAt",
          updated_at AS "updatedAt"
        FROM github_task_links
        WHERE
          repo_owner = ${input.repoOwner}
          AND repo_name = ${input.repoName}
          AND source_type = 'issue'
          AND pr_number IS NULL
          AND is_active = 1
        ORDER BY created_at ASC, id ASC
      `,
  });

  const attachPrToLinkRow = SqlSchema.void({
    Request: Schema.Struct({
      id: Schema.Number,
      prNumber: Schema.Number,
      updatedAt: Schema.String,
    }),
    execute: (input) =>
      sql`
        UPDATE github_task_links
        SET pr_number = ${input.prNumber}, updated_at = ${input.updatedAt}
        WHERE id = ${input.id}
      `,
  });

  const archiveLinkRow = SqlSchema.void({
    Request: Schema.Struct({
      id: Schema.Number,
      archivedAt: Schema.String,
      updatedAt: Schema.String,
    }),
    execute: (input) =>
      sql`
        UPDATE github_task_links
        SET is_active = 0, archived_at = ${input.archivedAt}, updated_at = ${input.updatedAt}
        WHERE id = ${input.id}
      `,
  });

  const insert: GithubTaskLinkRepositoryShape["insert"] = (input) =>
    insertTaskLink(input).pipe(
      Effect.mapError(toPersistenceSqlError("GithubTaskLinkRepository.insert:query")),
      Effect.flatMap((row) =>
        decodeTaskLink({
          ...row,
          isActive: row.isActive === 1,
        }),
      ),
    );

  const findActiveBySource: GithubTaskLinkRepositoryShape["findActiveBySource"] = (input) =>
    findActiveBySourceRow(input).pipe(
      Effect.mapError(toPersistenceSqlError("GithubTaskLinkRepository.findActiveBySource:query")),
      Effect.flatMap((row) =>
        Option.match(row, {
          onNone: () => Effect.succeed(Option.none()),
          onSome: (value) =>
            decodeTaskLink({
              ...value,
              isActive: value.isActive === 1,
            }).pipe(Effect.map(Option.some)),
        }),
      ),
    );

  const listActiveByPr: GithubTaskLinkRepositoryShape["listActiveByPr"] = (input) =>
    listActiveByPrRows(input).pipe(
      Effect.mapError(toPersistenceSqlError("GithubTaskLinkRepository.listActiveByPr:query")),
      Effect.flatMap((rows) =>
        Effect.forEach(rows, (row) =>
          decodeTaskLink({
            ...row,
            isActive: row.isActive === 1,
          }),
        ),
      ),
    );

  const listActiveIssueLinksWithoutPr: GithubTaskLinkRepositoryShape["listActiveIssueLinksWithoutPr"] =
    (input) =>
      listActiveIssueLinksWithoutPrRows(input).pipe(
        Effect.mapError(
          toPersistenceSqlError("GithubTaskLinkRepository.listActiveIssueLinksWithoutPr:query"),
        ),
        Effect.flatMap((rows) =>
          Effect.forEach(rows, (row) =>
            decodeTaskLink({
              ...row,
              isActive: row.isActive === 1,
            }),
          ),
        ),
      );

  const attachPrToLink: GithubTaskLinkRepositoryShape["attachPrToLink"] = (input) =>
    attachPrToLinkRow(input).pipe(
      Effect.mapError(toPersistenceSqlError("GithubTaskLinkRepository.attachPrToLink:query")),
    );

  const archiveLink: GithubTaskLinkRepositoryShape["archiveLink"] = (input) =>
    archiveLinkRow(input).pipe(
      Effect.mapError(toPersistenceSqlError("GithubTaskLinkRepository.archiveLink:query")),
    );

  return {
    insert,
    findActiveBySource,
    listActiveByPr,
    listActiveIssueLinksWithoutPr,
    attachPrToLink,
    archiveLink,
  } satisfies GithubTaskLinkRepositoryShape;
});

export const GithubTaskLinkRepositoryLive = Layer.effect(
  GithubTaskLinkRepository,
  makeGithubTaskLinkRepository,
);
