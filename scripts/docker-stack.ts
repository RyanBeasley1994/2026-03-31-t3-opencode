#!/usr/bin/env node
/**
 * Starts the T3 server on the host (so Docker nginx can reach it), then runs `docker compose`.
 *
 * Usage:
 *   bun run docker:stack -- up
 *   bun run docker:stack -- up -d
 *   bun run docker:stack -- down
 *
 * Port detection uses `T3_SERVER_UPSTREAM` (same as docker-compose), then `T3_SERVER_PORT`, then 3773.
 * If that port already accepts connections, the server is assumed to be running and is not started.
 */
import { spawn } from "node:child_process";
import { createConnection } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function parseServerPort(): number {
  const upstream = process.env.T3_SERVER_UPSTREAM;
  if (typeof upstream === "string" && upstream.length > 0) {
    const lastSegment = upstream.includes(":")
      ? upstream.slice(upstream.lastIndexOf(":") + 1)
      : upstream;
    const parsed = Number.parseInt(lastSegment, 10);
    if (!Number.isNaN(parsed)) {
      return parsed;
    }
  }
  const fromEnv = process.env.T3_SERVER_PORT;
  if (typeof fromEnv === "string" && fromEnv.length > 0) {
    const parsed = Number.parseInt(fromEnv, 10);
    if (!Number.isNaN(parsed)) {
      return parsed;
    }
  }
  return 3773;
}

function firstComposeSubcommand(args: readonly string[]): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === undefined) {
      break;
    }
    if (a === "-f" || a === "--file" || a === "-p" || a === "--project-name") {
      i += 1;
      continue;
    }
    if (a.startsWith("-")) {
      continue;
    }
    return a;
  }
  return undefined;
}

function isDetachCompose(args: readonly string[]): boolean {
  return args.includes("-d") || args.includes("--detach");
}

async function isPortOpen(port: number, host = "127.0.0.1"): Promise<boolean> {
  return await new Promise((resolve) => {
    const socket = createConnection({ port, host }, () => {
      socket.end();
      resolve(true);
    });
    socket.on("error", () => {
      resolve(false);
    });
  });
}

async function waitForPort(port: number, timeoutMs: number, host = "127.0.0.1"): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isPortOpen(port, host)) {
      return;
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for ${host}:${port}`);
}

async function runDockerCompose(args: readonly string[]): Promise<number | null> {
  return await new Promise((resolve, reject) => {
    const child = spawn("docker", ["compose", ...args], {
      cwd: repoRoot,
      stdio: "inherit",
      env: process.env,
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      resolve(code);
    });
  });
}

async function main(): Promise<void> {
  const composeArgs = process.argv.slice(2);
  if (composeArgs.length === 0) {
    console.error(
      "Usage: bun run docker:stack -- <docker compose args>\nExample: bun run docker:stack -- up",
    );
    process.exit(2);
  }

  const port = parseServerPort();
  let serverProcess: ReturnType<typeof spawn> | undefined;
  let startedServer = false;
  let leaveServerRunning = false;
  let exitCode = 0;

  const shouldEnsureServer = firstComposeSubcommand(composeArgs) === "up";

  try {
    if (shouldEnsureServer && !(await isPortOpen(port))) {
      serverProcess = spawn(
        process.execPath,
        [path.join(repoRoot, "scripts/dev-runner.ts"), "dev:server"],
        {
          cwd: repoRoot,
          stdio: "inherit",
          env: process.env,
        },
      );
      startedServer = true;

      const serverExit = new Promise<number | null>((resolve) => {
        serverProcess!.on("exit", (code) => resolve(code));
      });

      await Promise.race([
        waitForPort(port, 120_000),
        serverExit.then((code) => {
          throw new Error(`dev:server exited before listening (code ${code})`);
        }),
      ]);
    } else if (shouldEnsureServer) {
      console.error(`[docker-stack] Port ${port} is already open; skipping dev:server.`);
    }

    const code = await runDockerCompose(composeArgs);
    if (code !== 0 && code !== null) {
      exitCode = code;
    }

    const upAt = composeArgs.indexOf("up");
    if (
      upAt !== -1 &&
      isDetachCompose(composeArgs.slice(upAt + 1)) &&
      (code === 0 || code === null)
    ) {
      leaveServerRunning = true;
      console.error("[docker-stack] Detached compose finished; leaving host dev:server running.");
    }
  } finally {
    if (startedServer && serverProcess && !leaveServerRunning) {
      serverProcess.kill("SIGTERM");
    }
    if (startedServer && serverProcess && leaveServerRunning) {
      serverProcess.unref();
    }
  }

  process.exit(exitCode);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
