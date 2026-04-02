# Desktop Remote Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a connection mode picker to the Electron desktop app so it can connect to a remote T3 Code server instead of spawning a local backend.

**Architecture:** On first launch (no saved config), a styled HTML page asks the user to pick Local or Server mode. The choice persists to `~/.t3/userdata/connection.json`. On subsequent launches, bootstrap reads the config and either starts the local backend (current behavior) or loads the remote server URL directly in the Electron window.

**Tech Stack:** Electron 40, TypeScript, Node.js FS for config persistence

---

## File Structure

| File                                   | Action | Responsibility                                                            |
| -------------------------------------- | ------ | ------------------------------------------------------------------------- |
| `apps/desktop/src/connectionConfig.ts` | Create | Read/write/validate `connection.json`                                     |
| `apps/desktop/src/connectionScreen.ts` | Create | Generate the HTML string for the connection picker page                   |
| `apps/desktop/src/main.ts`             | Modify | Bootstrap branching, conditional backend lifecycle, new IPC channels      |
| `apps/desktop/src/preload.ts`          | Modify | Expose `saveConnectionConfig` IPC to the connection screen                |
| `packages/contracts/src/ipc.ts`        | Modify | Add `ConnectionConfig` type and `saveConnectionConfig` to `DesktopBridge` |

---

### Task 1: Connection Config Module

**Files:**

- Create: `apps/desktop/src/connectionConfig.ts`

- [ ] **Step 1: Create connectionConfig.ts with types and read/write functions**

```typescript
import * as FS from "node:fs";
import * as Path from "node:path";

export interface ConnectionConfig {
  mode: "local" | "server";
  serverUrl: string | null;
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
```

- [ ] **Step 2: Verify it compiles**

Run: `cd /Users/ryan/Documents/Repos/2026-03-31-t3-opencode && bun run --filter @t3tools/desktop typecheck`
Expected: No errors related to connectionConfig.ts

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/src/connectionConfig.ts
git commit -m "feat(desktop): add connection config read/write module"
```

---

### Task 2: Connection Screen HTML

**Files:**

- Create: `apps/desktop/src/connectionScreen.ts`

- [ ] **Step 1: Create connectionScreen.ts that returns an HTML string**

The screen must:

- Match the app's dark theme (`#0a0a0b` background, DM Sans font)
- Have a draggable title bar area (for macOS `hiddenInset` titlebar — needs `-webkit-app-region: drag`)
- Show two cards: Local and Server
- Server card reveals a URL input + Connect button
- Communicate the chosen config back to the main process via `window.desktopBridge.saveConnectionConfig()`

```typescript
/**
 * Returns a self-contained HTML document string for the connection mode picker.
 * Rendered directly into the BrowserWindow before the main app loads.
 */
export function connectionScreenHtml(): string {
  return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>T3 Code</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    font-family: 'DM Sans', -apple-system, BlinkMacSystemFont, sans-serif;
    background: #0a0a0b;
    color: #e4e4e7;
    height: 100vh;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    -webkit-font-smoothing: antialiased;
  }
  .drag-region {
    position: fixed;
    top: 0; left: 0; right: 0;
    height: 52px;
    -webkit-app-region: drag;
  }
  h1 {
    font-size: 24px;
    font-weight: 600;
    margin-bottom: 8px;
    color: #fafafa;
  }
  .subtitle {
    font-size: 14px;
    color: #71717a;
    margin-bottom: 32px;
  }
  .cards {
    display: flex;
    gap: 16px;
  }
  .card {
    width: 240px;
    padding: 24px;
    background: #18181b;
    border: 1px solid #27272a;
    border-radius: 12px;
    cursor: pointer;
    transition: border-color 0.15s, background 0.15s;
    -webkit-app-region: no-drag;
  }
  .card:hover {
    border-color: #3f3f46;
    background: #1c1c1f;
  }
  .card.selected {
    border-color: #a78bfa;
    background: #1c1c1f;
  }
  .card-title {
    font-size: 16px;
    font-weight: 600;
    margin-bottom: 6px;
    color: #fafafa;
  }
  .card-desc {
    font-size: 13px;
    color: #71717a;
    line-height: 1.5;
  }
  .server-form {
    display: none;
    margin-top: 24px;
    width: 496px;
  }
  .server-form.visible { display: flex; gap: 8px; }
  .server-form input {
    flex: 1;
    padding: 10px 14px;
    background: #18181b;
    border: 1px solid #27272a;
    border-radius: 8px;
    color: #e4e4e7;
    font-size: 14px;
    font-family: inherit;
    outline: none;
    transition: border-color 0.15s;
  }
  .server-form input:focus { border-color: #a78bfa; }
  .server-form input::placeholder { color: #52525b; }
  .connect-btn {
    padding: 10px 20px;
    background: #a78bfa;
    color: #0a0a0b;
    border: none;
    border-radius: 8px;
    font-size: 14px;
    font-weight: 600;
    font-family: inherit;
    cursor: pointer;
    transition: opacity 0.15s;
  }
  .connect-btn:hover { opacity: 0.9; }
  .connect-btn:disabled { opacity: 0.5; cursor: not-allowed; }
  .error {
    color: #f87171;
    font-size: 13px;
    margin-top: 8px;
    display: none;
    width: 496px;
  }
  .error.visible { display: block; }
</style>
</head>
<body>
  <div class="drag-region"></div>
  <h1>T3 Code</h1>
  <p class="subtitle">How do you want to run T3 Code?</p>
  <div class="cards">
    <div class="card" id="card-local" onclick="selectLocal()">
      <div class="card-title">Local</div>
      <div class="card-desc">Run the server on this machine. Everything stays local.</div>
    </div>
    <div class="card" id="card-server" onclick="selectServer()">
      <div class="card-title">Server</div>
      <div class="card-desc">Connect to a remote T3 Code server.</div>
    </div>
  </div>
  <div class="server-form" id="server-form">
    <input type="url" id="server-url" placeholder="https://your-server.example.com" autofocus />
    <button class="connect-btn" id="connect-btn" onclick="connectToServer()">Connect</button>
  </div>
  <div class="error" id="error-msg"></div>
  <script>
    function selectLocal() {
      document.getElementById('card-local').classList.add('selected');
      document.getElementById('card-server').classList.remove('selected');
      document.getElementById('server-form').classList.remove('visible');
      document.getElementById('error-msg').classList.remove('visible');
      window.desktopBridge.saveConnectionConfig({ mode: 'local', serverUrl: null });
    }
    function selectServer() {
      document.getElementById('card-server').classList.add('selected');
      document.getElementById('card-local').classList.remove('selected');
      document.getElementById('server-form').classList.add('visible');
      document.getElementById('server-url').focus();
    }
    function connectToServer() {
      var url = document.getElementById('server-url').value.trim();
      var errorEl = document.getElementById('error-msg');
      if (!url.startsWith('http://') && !url.startsWith('https://')) {
        errorEl.textContent = 'URL must start with http:// or https://';
        errorEl.classList.add('visible');
        return;
      }
      errorEl.classList.remove('visible');
      window.desktopBridge.saveConnectionConfig({ mode: 'server', serverUrl: url });
    }
    document.getElementById('server-url').addEventListener('keydown', function(e) {
      if (e.key === 'Enter') connectToServer();
    });
  </script>
</body>
</html>`;
}
```

- [ ] **Step 2: Verify it compiles**

Run: `cd /Users/ryan/Documents/Repos/2026-03-31-t3-opencode && bun run --filter @t3tools/desktop typecheck`
Expected: Type error on `window.desktopBridge.saveConnectionConfig` — this is expected, will be fixed in Task 3.

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/src/connectionScreen.ts
git commit -m "feat(desktop): add connection screen HTML generator"
```

---

### Task 3: Update Contracts and Preload

**Files:**

- Modify: `packages/contracts/src/ipc.ts:118-134` (DesktopBridge interface)
- Modify: `apps/desktop/src/preload.ts`

- [ ] **Step 1: Add ConnectionConfig type and saveConnectionConfig to DesktopBridge**

In `packages/contracts/src/ipc.ts`, add before the `DesktopBridge` interface:

```typescript
export interface ConnectionConfig {
  mode: "local" | "server";
  serverUrl: string | null;
}
```

Add to the `DesktopBridge` interface:

```typescript
saveConnectionConfig: (config: ConnectionConfig) => Promise<void>;
```

- [ ] **Step 2: Add IPC channel to preload.ts**

In `apps/desktop/src/preload.ts`, add the channel constant:

```typescript
const SAVE_CONNECTION_CONFIG_CHANNEL = "desktop:save-connection-config";
```

Add to the `contextBridge.exposeInMainWorld` object:

```typescript
  saveConnectionConfig: (config) => ipcRenderer.invoke(SAVE_CONNECTION_CONFIG_CHANNEL, config),
```

- [ ] **Step 3: Verify it compiles**

Run: `cd /Users/ryan/Documents/Repos/2026-03-31-t3-opencode && bun typecheck`
Expected: Pass (the main process handler doesn't exist yet but preload just invokes — it won't fail typecheck)

- [ ] **Step 4: Commit**

```bash
git add packages/contracts/src/ipc.ts apps/desktop/src/preload.ts
git commit -m "feat(contracts): add ConnectionConfig type and saveConnectionConfig to DesktopBridge"
```

---

### Task 4: Wire Up main.ts — Config, IPC, and Bootstrap Branching

**Files:**

- Modify: `apps/desktop/src/main.ts`

This is the core task. Changes to `main.ts`:

1. Import the new modules
2. Add a module-level `connectionMode` variable
3. Add the `saveConnectionConfig` IPC handler (writes config, reloads window)
4. Modify `bootstrap()` to branch on config mode
5. Modify `getWsUrl` IPC to return `""` in server mode
6. Guard backend lifecycle functions in server mode

- [ ] **Step 1: Add imports at the top of main.ts**

After the existing imports (around line 31), add:

```typescript
import { readConnectionConfig, writeConnectionConfig } from "./connectionConfig";
import { connectionScreenHtml } from "./connectionScreen";
```

- [ ] **Step 2: Add module-level state variable**

After `let backendWsUrl = "";` (line 88), add:

```typescript
let connectionMode: "local" | "server" | "pending" = "pending";
let remoteServerUrl = "";
```

- [ ] **Step 3: Add the SAVE_CONNECTION_CONFIG IPC channel constant**

After `const GET_WS_URL_CHANNEL = "desktop:get-ws-url";` (line 61), add:

```typescript
const SAVE_CONNECTION_CONFIG_CHANNEL = "desktop:save-connection-config";
```

- [ ] **Step 4: Add the IPC handler inside registerIpcHandlers()**

At the end of `registerIpcHandlers()` (before the closing `}`), add:

```typescript
ipcMain.removeHandler(SAVE_CONNECTION_CONFIG_CHANNEL);
ipcMain.handle(SAVE_CONNECTION_CONFIG_CHANNEL, async (_event, rawConfig: unknown) => {
  if (typeof rawConfig !== "object" || rawConfig === null) return;
  const config = rawConfig as Record<string, unknown>;
  if (config.mode !== "local" && config.mode !== "server") return;
  if (config.mode === "server" && typeof config.serverUrl !== "string") return;

  const validated = {
    mode: config.mode as "local" | "server",
    serverUrl: config.mode === "server" ? (config.serverUrl as string) : null,
  };
  writeConnectionConfig(STATE_DIR, validated);
  connectionMode = validated.mode;
  remoteServerUrl = validated.serverUrl ?? "";

  if (connectionMode === "local") {
    // Start backend and load the bundled app
    backendPort = await Effect.service(NetService).pipe(
      Effect.flatMap((net) => net.reserveLoopbackPort()),
      Effect.provide(NetService.layer),
      Effect.runPromise,
    );
    backendAuthToken = Crypto.randomBytes(24).toString("hex");
    backendWsUrl = `ws://127.0.0.1:${backendPort}/?token=${encodeURIComponent(backendAuthToken)}`;
    startBackend();
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (isDevelopment) {
        void mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL as string);
      } else {
        void mainWindow.loadURL(`${DESKTOP_SCHEME}://app/index.html`);
      }
    }
  } else {
    // Server mode — load the remote URL directly
    if (mainWindow && !mainWindow.isDestroyed()) {
      void mainWindow.loadURL(remoteServerUrl);
    }
  }
});
```

- [ ] **Step 5: Modify the getWsUrl IPC handler**

Replace the existing `GET_WS_URL_CHANNEL` handler body in `registerIpcHandlers()`:

```typescript
ipcMain.removeAllListeners(GET_WS_URL_CHANNEL);
ipcMain.on(GET_WS_URL_CHANNEL, (event) => {
  event.returnValue = connectionMode === "server" ? "" : backendWsUrl;
});
```

- [ ] **Step 6: Replace the bootstrap() function**

Replace the entire `bootstrap()` function (lines 1385–1403) with:

```typescript
async function bootstrap(): Promise<void> {
  writeDesktopLogHeader("bootstrap start");

  registerIpcHandlers();
  writeDesktopLogHeader("bootstrap ipc handlers registered");

  const config = readConnectionConfig(STATE_DIR);

  if (!config) {
    // First launch — show connection picker
    connectionMode = "pending";
    writeDesktopLogHeader("bootstrap no config found, showing connection screen");
    mainWindow = createWindow();
    writeDesktopLogHeader("bootstrap main window created (connection screen)");
    return;
  }

  connectionMode = config.mode;
  remoteServerUrl = config.serverUrl ?? "";
  writeDesktopLogHeader(`bootstrap config loaded mode=${connectionMode}`);

  if (connectionMode === "local") {
    backendPort = await Effect.service(NetService).pipe(
      Effect.flatMap((net) => net.reserveLoopbackPort()),
      Effect.provide(NetService.layer),
      Effect.runPromise,
    );
    writeDesktopLogHeader(`reserved backend port via NetService port=${backendPort}`);
    backendAuthToken = Crypto.randomBytes(24).toString("hex");
    backendWsUrl = `ws://127.0.0.1:${backendPort}/?token=${encodeURIComponent(backendAuthToken)}`;
    writeDesktopLogHeader(`bootstrap resolved websocket endpoint`);
    startBackend();
    writeDesktopLogHeader("bootstrap backend start requested");
  } else {
    writeDesktopLogHeader(`bootstrap server mode, remote=${remoteServerUrl}`);
  }

  mainWindow = createWindow();
  writeDesktopLogHeader("bootstrap main window created");
}
```

- [ ] **Step 7: Modify createWindow() to handle all three modes**

Replace the URL loading block in `createWindow()` (lines 1362-1367) with:

```typescript
if (connectionMode === "pending") {
  void window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(connectionScreenHtml())}`);
} else if (connectionMode === "server") {
  void window.loadURL(remoteServerUrl);
} else if (isDevelopment) {
  void window.loadURL(process.env.VITE_DEV_SERVER_URL as string);
  window.webContents.openDevTools({ mode: "detach" });
} else {
  void window.loadURL(`${DESKTOP_SCHEME}://app/index.html`);
}
```

- [ ] **Step 8: Guard backend lifecycle on mode**

In `stopBackend()` (line 1052), add an early return at the top:

```typescript
function stopBackend(): void {
  if (connectionMode === "server") return;
  // ... rest unchanged
```

In `scheduleBackendRestart()` (line 962), add an early return at the top:

```typescript
function scheduleBackendRestart(reason: string): void {
  if (connectionMode === "server") return;
  // ... rest unchanged
```

- [ ] **Step 9: Verify it compiles**

Run: `cd /Users/ryan/Documents/Repos/2026-03-31-t3-opencode && bun typecheck`
Expected: Pass

- [ ] **Step 10: Commit**

```bash
git add apps/desktop/src/main.ts
git commit -m "feat(desktop): add remote server mode with connection picker on first launch"
```

---

### Task 5: Verify and Format

- [ ] **Step 1: Run formatter**

Run: `cd /Users/ryan/Documents/Repos/2026-03-31-t3-opencode && bun fmt`

- [ ] **Step 2: Run linter**

Run: `cd /Users/ryan/Documents/Repos/2026-03-31-t3-opencode && bun lint`
Fix any issues.

- [ ] **Step 3: Run typecheck**

Run: `cd /Users/ryan/Documents/Repos/2026-03-31-t3-opencode && bun typecheck`
Expected: Pass

- [ ] **Step 4: Run tests**

Run: `cd /Users/ryan/Documents/Repos/2026-03-31-t3-opencode && bun run test`
Expected: Pass (no existing tests break)

- [ ] **Step 5: Commit any formatting fixes**

```bash
git add -u
git commit -m "style: format desktop remote mode changes"
```

---

### Task 6: Manual Smoke Test

- [ ] **Step 1: Delete any existing connection config**

```bash
rm -f ~/.t3/userdata/connection.json
```

- [ ] **Step 2: Start the desktop app in dev mode**

```bash
cd /Users/ryan/Documents/Repos/2026-03-31-t3-opencode && bun run --filter @t3tools/desktop dev
```

- [ ] **Step 3: Verify connection screen appears**

Expected: A dark-themed screen with two cards (Local / Server) appears.

- [ ] **Step 4: Test Local mode**

Click "Local" — app should save config and reload into the normal local app experience.

- [ ] **Step 5: Reset and test Server mode**

```bash
rm ~/.t3/userdata/connection.json
```

Restart the app. Click "Server", enter a remote URL, click "Connect" — app should save config and load the remote URL.

- [ ] **Step 6: Verify config persistence**

Restart the app. It should skip the connection screen and go directly to the saved mode.
