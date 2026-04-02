# Desktop Remote Mode

## Overview

Add a connection mode picker to the desktop app so it can either run a local backend (current behavior) or connect to a remote T3 Code server. The choice is made on first launch and persisted.

## Connection Screen

On first launch (no `connection.json` exists), the desktop app displays a full-window styled HTML page before loading the main app.

### Layout

- Dark-themed page matching the app's existing visual language
- Two clickable cards side by side:
  - **Local** — "Run everything on this machine" — saves config and proceeds immediately
  - **Server** — "Connect to a remote T3 Code server" — reveals a URL input
- Server card shows a text input for the server URL (e.g., `https://aicoder.propriotec.app`) and a "Connect" button
- Basic validation: URL must start with `http://` or `https://`

### Behavior

- Selecting Local writes `{ "mode": "local" }` to config and proceeds to normal bootstrap
- Selecting Server + entering URL + clicking Connect writes `{ "mode": "server", "serverUrl": "<url>" }` and proceeds to remote bootstrap
- On subsequent launches, the config is read and the screen is skipped entirely

## Config Persistence

- **File:** `~/.t3/userdata/connection.json`
- **Schema:**
  ```json
  { "mode": "local" | "server", "serverUrl": string | null }
  ```
- Read synchronously at bootstrap time (before deciding whether to spawn the backend)
- The `STATE_DIR` (`~/.t3/userdata/`) already exists in the current codebase

## Bootstrap Changes

### Local Mode (or no config)

No changes. Current behavior:

1. Reserve loopback port via `NetService`
2. Generate auth token
3. Start backend child process
4. Set `backendWsUrl` to `ws://127.0.0.1:{port}/?token={token}`
5. Load bundled UI via `t3://app/index.html`

### Server Mode

1. Skip port reservation, auth token generation, and `startBackend()`
2. Load `serverUrl` directly in the Electron window via `window.loadURL(serverUrl)`
3. The web app auto-discovers the WebSocket URL from `window.location` (falls through the priority chain in `wsTransport.ts` line 75)
4. `getWsUrl()` in preload returns empty string so the web app uses auto-discovery

### Lifecycle

- `before-quit`: Skip `stopBackend()` in server mode (no backend to stop)
- `scheduleBackendRestart`: No-op in server mode
- Window close / SIGINT / SIGTERM: No backend cleanup needed in server mode

## Preload / IPC

- `desktopBridge.getWsUrl()` returns `""` in server mode (triggers auto-discovery)
- Desktop-specific IPC channels (folder picker, theme, context menu, updates) still function normally — the preload script is loaded regardless of mode
- New IPC channels:
  - `desktop:get-connection-config` — returns saved config or `null`
  - `desktop:save-connection-config` — writes config to disk, triggers app reload

## Reset Path

To change mode: delete `~/.t3/userdata/connection.json` and restart the app. The connection screen reappears.

## Files

| File                                   | Change                                                            |
| -------------------------------------- | ----------------------------------------------------------------- |
| `apps/desktop/src/connectionConfig.ts` | New. Read/write `connection.json`                                 |
| `apps/desktop/src/connectionScreen.ts` | New. Generate styled HTML for the picker screen                   |
| `apps/desktop/src/main.ts`             | Bootstrap branching on config mode, conditional backend lifecycle |
| `apps/desktop/src/preload.ts`          | Expose `getConnectionConfig` / `saveConnectionConfig` IPC         |

## Security Notes

- Server URL is validated (must be http/https) before saving or loading
- No auth tokens are generated or stored in server mode — authentication is the remote server's responsibility
- The preload sandbox and context isolation remain enabled in both modes
