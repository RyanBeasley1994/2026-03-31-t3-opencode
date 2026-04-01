import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS github_webhook_deliveries (
      delivery_id TEXT PRIMARY KEY,
      event_name TEXT NOT NULL,
      received_at TEXT NOT NULL
    )
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS github_task_links (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      repo_owner TEXT NOT NULL,
      repo_name TEXT NOT NULL,
      source_type TEXT NOT NULL,
      source_number INTEGER NOT NULL,
      pr_number INTEGER,
      source_branch TEXT,
      thread_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      is_active INTEGER NOT NULL DEFAULT 1,
      archived_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_github_task_links_source
    ON github_task_links(repo_owner, repo_name, source_type, source_number, is_active, created_at)
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_github_task_links_pr
    ON github_task_links(repo_owner, repo_name, pr_number, is_active, created_at)
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS github_worktree_cleanup_jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      worktree_path TEXT NOT NULL,
      project_id TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      repo_owner TEXT NOT NULL,
      repo_name TEXT NOT NULL,
      pr_number INTEGER,
      issue_number INTEGER,
      installation_id INTEGER NOT NULL,
      attempt_count INTEGER NOT NULL DEFAULT 0,
      next_attempt_at TEXT NOT NULL,
      status TEXT NOT NULL,
      last_error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      completed_at TEXT
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_github_worktree_cleanup_jobs_due
    ON github_worktree_cleanup_jobs(status, next_attempt_at, id)
  `;
});
