import * as FS from "node:fs";
import * as Path from "node:path";

export interface ConnectionConfig {
  mode: "local" | "server";
  serverUrl: string | null;
  authToken: string | null;
}

const CONFIG_FILENAME = "connection.json";

function configPath(stateDir: string): string {
  return Path.join(stateDir, CONFIG_FILENAME);
}

export function readConnectionConfig(stateDir: string): ConnectionConfig | null {
  const filePath = configPath(stateDir);
  if (!FS.existsSync(filePath)) return null;

  try {
    const raw = FS.readFileSync(filePath, "utf-8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (parsed.mode !== "local" && parsed.mode !== "server") return null;
    if (parsed.mode === "server" && typeof parsed.serverUrl !== "string") return null;
    if (parsed.mode === "server") {
      const url = parsed.serverUrl as string;
      if (!url.startsWith("http://") && !url.startsWith("https://")) return null;
    }
    return {
      mode: parsed.mode,
      serverUrl: parsed.mode === "server" ? (parsed.serverUrl as string) : null,
      authToken:
        parsed.mode === "server" && typeof parsed.authToken === "string"
          ? (parsed.authToken as string)
          : null,
    };
  } catch {
    return null;
  }
}

export function writeConnectionConfig(stateDir: string, config: ConnectionConfig): void {
  const filePath = configPath(stateDir);
  FS.mkdirSync(Path.dirname(filePath), { recursive: true });
  FS.writeFileSync(filePath, JSON.stringify(config, null, 2), "utf-8");
}

export function deleteConnectionConfig(stateDir: string): void {
  const filePath = configPath(stateDir);
  try {
    FS.unlinkSync(filePath);
  } catch {
    // Already gone — nothing to do
  }
}
