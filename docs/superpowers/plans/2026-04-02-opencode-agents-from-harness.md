# OpenCode Agents from Harness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the hardcoded `"plan" | "default"` interaction mode toggle with a dynamic agent picker that fetches available agents from the OpenCode harness (e.g. `build`, `plan`, `explore`, `general`, custom user agents).

**Architecture:** Widen `ProviderInteractionMode` from a two-value literal union to `string` so it can carry any OpenCode agent name. Add an `agents` field to `ServerProvider` so the frontend knows which agents are available per provider. Fetch agents from the OpenCode SDK's `/agent` endpoint alongside the existing provider catalog. Update the UI to render the actual agent list instead of a hardcoded plan/chat toggle.

**Tech Stack:** Effect/Schema (contracts), OpenCode SDK (`@opencode-ai/sdk`), React (web UI)

---

### Task 1: Widen `ProviderInteractionMode` to accept any string

Currently `ProviderInteractionMode` is `Schema.Literals(["default", "plan"])`. OpenCode agents can be any name (`build`, `plan`, `explore`, `general`, user-defined). We need to widen this to `string` while keeping a sensible default.

**Files:**

- Modify: `packages/contracts/src/orchestration.ts:101-103`
- Modify: `packages/contracts/src/server.ts:53-63` (add `agents` to `ServerProvider`)

- [ ] **Step 1: Widen `ProviderInteractionMode` to `string`**

In `packages/contracts/src/orchestration.ts`, change:

```typescript
// Before
export const ProviderInteractionMode = Schema.Literals(["default", "plan"]);
export type ProviderInteractionMode = typeof ProviderInteractionMode.Type;
export const DEFAULT_PROVIDER_INTERACTION_MODE: ProviderInteractionMode = "default";

// After
export const ProviderInteractionMode = Schema.String.pipe(Schema.nonEmptyString());
export type ProviderInteractionMode = typeof ProviderInteractionMode.Type;
export const DEFAULT_PROVIDER_INTERACTION_MODE: ProviderInteractionMode = "build";
```

Key decisions:

- The default changes from `"default"` to `"build"` because OpenCode's default agent is `build`, not `default`. The old `"default"` value mapped to `"build"` in the adapter — this removes that indirection.
- `Schema.String` with `nonEmptyString()` so any agent name is valid.

- [ ] **Step 2: Add `ServerProviderAgent` and `agents` field to `ServerProvider`**

In `packages/contracts/src/server.ts`, add a schema for agents and include it in `ServerProvider`:

```typescript
export const ServerProviderAgent = Schema.Struct({
  name: TrimmedNonEmptyString,
  description: Schema.optional(TrimmedNonEmptyString),
  builtIn: Schema.Boolean,
  color: Schema.optional(TrimmedNonEmptyString),
});
export type ServerProviderAgent = typeof ServerProviderAgent.Type;

export const ServerProvider = Schema.Struct({
  provider: ProviderKind,
  enabled: Schema.Boolean,
  installed: Schema.Boolean,
  version: Schema.NullOr(TrimmedNonEmptyString),
  status: ServerProviderState,
  auth: ServerProviderAuth,
  checkedAt: IsoDateTime,
  message: Schema.optional(TrimmedNonEmptyString),
  models: Schema.Array(ServerProviderModel),
  agents: Schema.Array(ServerProviderAgent), // NEW
});
```

- [ ] **Step 3: Run typecheck to find all downstream breakages**

Run: `bun typecheck 2>&1 | head -80`

This will reveal every place that constructs a `ServerProvider` or depends on the old `ProviderInteractionMode` literal type. These are the files we'll fix in subsequent tasks. Note them down.

- [ ] **Step 4: Commit**

```bash
git add packages/contracts/src/orchestration.ts packages/contracts/src/server.ts
git commit -m "feat: widen ProviderInteractionMode to string, add agents to ServerProvider"
```

---

### Task 2: Update the OpenCode adapter and pool to map agent names correctly

Now that `ProviderInteractionMode` is a string (agent name), the adapter no longer needs the `"default" → "build"` / `"plan" → "plan"` mapping. It can pass the agent name through directly. We also need to fetch the agent list from the SDK.

**Files:**

- Modify: `apps/server/src/provider/Layers/OpenCodeAdapter.ts:1665` (remove mapping)
- Modify: `apps/server/src/provider/opencodeEventMapping.ts:263-265` (`isPlanAgent` — update for new semantics)
- Modify: `apps/server/src/provider/Services/OpenCodeServerPool.ts` (add agents to catalog)
- Modify: `apps/server/src/provider/Layers/OpenCodeServerPool.ts:336-360` (fetch agents)
- Modify: `apps/server/src/provider/Layers/OpenCodeProvider.ts` (pass agents to `ServerProvider`)

- [ ] **Step 1: Pass agent name directly in OpenCodeAdapter**

In `apps/server/src/provider/Layers/OpenCodeAdapter.ts`, change line 1665:

```typescript
// Before
const agent = input.interactionMode === "plan" ? "plan" : "build";

// After
const agent = input.interactionMode;
```

- [ ] **Step 2: Update `isPlanAgent` to match the new semantics**

In `apps/server/src/provider/opencodeEventMapping.ts`, `isPlanAgent` is still useful for detecting plan-mode responses from the assistant. Keep it as-is — it checks the assistant message's `.agent` field, not our input.

No changes needed here. Verify by reading the usage at `OpenCodeAdapter.ts:725`.

- [ ] **Step 3: Add agents to `OpenCodeProviderCatalog`**

In `apps/server/src/provider/Services/OpenCodeServerPool.ts`:

```typescript
export interface OpenCodeProviderCatalog {
  readonly defaultModel: string;
  readonly models: ReadonlyArray<ServerProvider["models"][number]>;
  readonly agents: ReadonlyArray<{
    name: string;
    description?: string;
    builtIn: boolean;
    color?: string;
  }>;
}
```

- [ ] **Step 4: Fetch agents in `loadProviderCatalog`**

In `apps/server/src/provider/Layers/OpenCodeServerPool.ts`, modify `loadProviderCatalog`:

```typescript
const loadProviderCatalog: OpenCodeServerPoolShape["loadProviderCatalog"] = (input) =>
  Effect.gen(function* () {
    const lease = yield* acquire(input);
    try {
      const [providers, agents] = yield* Effect.all([
        Effect.tryPromise({
          try: () =>
            lease.client.config
              .providers(undefined, { throwOnError: true })
              .then((result) => result.data),
          catch: (cause) =>
            toRequestError(
              "config.providers",
              cause instanceof Error ? cause.message : "Failed to load OpenCode provider catalog.",
              cause,
            ),
        }),
        Effect.tryPromise({
          try: () =>
            lease.client.agents(undefined, { throwOnError: true }).then((result) => result.data),
          catch: (cause) =>
            toRequestError(
              "agents",
              cause instanceof Error ? cause.message : "Failed to load OpenCode agents.",
              cause,
            ),
        }),
      ]);

      return {
        ...toOpenCodeProviderCatalog({
          providers: providers.providers,
          defaultByProvider: providers.default,
        }),
        agents: agents
          .filter((a) => a.mode === "primary" || a.mode === "all")
          .map((a) => ({
            name: a.name,
            ...(a.description ? { description: a.description } : {}),
            builtIn: a.builtIn,
            ...(a.color ? { color: a.color } : {}),
          })),
      };
    } finally {
      yield* lease.release;
    }
  });
```

Key: We filter to `mode === "primary" || mode === "all"` because `"subagent"` agents aren't selectable as top-level interaction modes.

- [ ] **Step 5: Pass agents through to `ServerProvider` in OpenCodeProvider**

In `apps/server/src/provider/Layers/OpenCodeProvider.ts`, update the `checkProvider` function to include agents in the returned `ServerProvider`:

```typescript
// In the success path (~line 223):
return {
  ...status,
  models: providerModelsFromCatalog(
    BUILT_IN_MODELS,
    catalog.success.models,
    opencodeSettings.customModels,
  ),
  agents: catalog.success.agents,
} satisfies ServerProvider;

// In the error path (~line 219):
return {
  ...status,
  status: "error",
  message: /* ... */,
  models: providerModelsFromCatalog(BUILT_IN_MODELS, [], opencodeSettings.customModels),
  agents: [],
} satisfies ServerProvider;
```

- [ ] **Step 6: Add empty `agents: []` to all other `ServerProvider` constructors**

Search for `satisfies ServerProvider` across the codebase. Every place that constructs a `ServerProvider` needs `agents: []` added. This includes:

- `apps/server/src/provider/Layers/OpenCodeProvider.ts` (multiple paths)
- `apps/server/src/provider/Layers/CodexProvider.ts`
- `apps/server/src/provider/Layers/ClaudeProvider.ts`
- `apps/server/src/provider/providerSnapshot.ts` (the `buildServerProvider` helper)
- Any test files constructing `ServerProvider` objects

- [ ] **Step 7: Run typecheck and fix remaining issues**

Run: `bun typecheck`

Fix any remaining type errors from the widened `ProviderInteractionMode`.

- [ ] **Step 8: Run tests**

Run: `npx vitest run apps/server/src/provider/`

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "feat: fetch OpenCode agents from harness and expose in ServerProvider"
```

---

### Task 3: Fix all migration of `"default"` → `"build"` in existing data

Existing threads in the database have `interactionMode: "default"`. With the new semantics, the default agent name is `"build"`. We need to handle this gracefully.

**Files:**

- Modify: `apps/server/src/provider/Layers/OpenCodeAdapter.ts` (map legacy `"default"` on read)
- Modify: `apps/server/src/orchestration/projector.ts` (or wherever thread interactionMode is read)

- [ ] **Step 1: Map legacy `"default"` to `"build"` at the adapter boundary**

In the OpenCode adapter's `sendTurn`, normalize the incoming `interactionMode`:

```typescript
// At the top of the sendTurn handler, after extracting input.interactionMode
const agent = input.interactionMode === "default" ? "build" : input.interactionMode;
```

This keeps backward compatibility: old threads with `"default"` still work, while new threads use actual agent names.

- [ ] **Step 2: Do the same normalization in the Codex adapter if needed**

Check `apps/server/src/codexAppServerManager.ts` — if it uses `interactionMode`, apply the same normalization. Codex uses `"plan"` and ignores `"default"`, so this should be fine. Verify and skip if no change needed.

- [ ] **Step 3: For Claude adapter, `"default"` and `"plan"` are the only valid modes**

Check `apps/server/src/provider/Layers/ClaudeAdapter.ts:2876-2882`. Claude adapter checks `input.interactionMode === "plan"` to set permission mode. With the widened type, this still works — any non-`"plan"` value is treated as default. No change needed.

- [ ] **Step 4: Run tests**

Run: `npx vitest run apps/server/src/provider/ apps/server/src/orchestration/`

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "fix: normalize legacy 'default' interactionMode to 'build' for OpenCode"
```

---

### Task 4: Update the web UI to show dynamic agent list

Replace the hardcoded plan/chat toggle with an agent picker that uses the agents from the provider status.

**Files:**

- Modify: `apps/web/src/components/chat/CompactComposerControlsMenu.tsx`
- Modify: `apps/web/src/components/ChatView.tsx` (toggle button, slash commands, agent items)
- Modify: `apps/web/src/composer-logic.ts` (widen `ComposerSlashCommand`, `parseStandaloneComposerSlashCommand`)
- Modify: `apps/web/src/types.ts` (update `DEFAULT_INTERACTION_MODE`)

- [ ] **Step 1: Update default interaction mode**

In `apps/web/src/types.ts`:

```typescript
// Before
export const DEFAULT_INTERACTION_MODE: ProviderInteractionMode = "default";

// After
export const DEFAULT_INTERACTION_MODE: ProviderInteractionMode = "build";
```

- [ ] **Step 2: Update `CompactComposerControlsMenu` to accept and render dynamic agents**

```typescript
// Props change:
export const CompactComposerControlsMenu = memo(function CompactComposerControlsMenu(props: {
  activePlan: boolean;
  interactionMode: ProviderInteractionMode;
  agents: ReadonlyArray<{ name: string; description?: string; color?: string }>;
  planSidebarOpen: boolean;
  runtimeMode: RuntimeMode;
  traitsMenuContent?: ReactNode;
  onInteractionModeChange: (mode: string) => void;
  onTogglePlanSidebar: () => void;
  onToggleRuntimeMode: () => void;
}) {
```

Replace the hardcoded `MenuRadioGroup` for mode:

```tsx
<div className="px-2 py-1.5 font-medium text-muted-foreground text-xs">Agent</div>
<MenuRadioGroup
  value={props.interactionMode}
  onValueChange={(value) => {
    if (!value || value === props.interactionMode) return;
    props.onInteractionModeChange(value);
  }}
>
  {props.agents.map((agent) => (
    <MenuRadioItem key={agent.name} value={agent.name}>
      {agent.name}
    </MenuRadioItem>
  ))}
</MenuRadioGroup>
```

If `props.agents` is empty (non-OpenCode providers), fall back to the old plan/build radio group:

```tsx
{props.agents.length > 0 ? (
  /* dynamic agent radio group */
) : (
  /* legacy plan/default radio group */
)}
```

- [ ] **Step 3: Update `ChatView.tsx` — replace `toggleInteractionMode` with `handleInteractionModeChange`**

The toggle function currently flips between two values. Replace with direct mode setting:

- `toggleInteractionMode` → keep for keyboard shortcut (Shift+Tab), but cycle through available agents
- `onToggleInteractionMode` prop on `CompactComposerControlsMenu` → replace with `onInteractionModeChange`
- The inline button for non-compact view: change from a binary toggle to a dropdown or cycle button

For the non-compact inline button (~line 4145-4161), replace the simple toggle button with a button that cycles through agents:

```tsx
<Button
  variant="ghost"
  className="shrink-0 whitespace-nowrap px-2 text-muted-foreground/70 hover:text-foreground/80 sm:px-3"
  size="sm"
  type="button"
  onClick={toggleInteractionMode}
  title={`Agent: ${interactionMode}`}
>
  <BotIcon />
  <span className="sr-only sm:not-sr-only">{interactionMode}</span>
</Button>
```

Update `toggleInteractionMode` to cycle through available agents:

```typescript
const availableAgents = useMemo(() => {
  const provider = providerStatuses.find((p) => p.provider === selectedProvider);
  return provider?.agents ?? [];
}, [providerStatuses, selectedProvider]);

const toggleInteractionMode = useCallback(() => {
  if (availableAgents.length > 0) {
    const currentIndex = availableAgents.findIndex((a) => a.name === interactionMode);
    const nextIndex = (currentIndex + 1) % availableAgents.length;
    handleInteractionModeChange(availableAgents[nextIndex]!.name);
  } else {
    // Legacy fallback for non-OpenCode providers
    handleInteractionModeChange(interactionMode === "plan" ? "build" : "plan");
  }
}, [availableAgents, handleInteractionModeChange, interactionMode]);
```

- [ ] **Step 4: Pass agents to `CompactComposerControlsMenu`**

In `ChatView.tsx` where `CompactComposerControlsMenu` is rendered (~line 4116):

```tsx
<CompactComposerControlsMenu
  activePlan={Boolean(activePlan || sidebarProposedPlan || planSidebarOpen)}
  interactionMode={interactionMode}
  agents={availableAgents}
  planSidebarOpen={planSidebarOpen}
  runtimeMode={runtimeMode}
  traitsMenuContent={providerTraitsMenuContent}
  onInteractionModeChange={handleInteractionModeChange}
  onTogglePlanSidebar={togglePlanSidebar}
  onToggleRuntimeMode={toggleRuntimeMode}
/>
```

- [ ] **Step 5: Update slash command items for dynamic agents**

In `ChatView.tsx` (~line 1239-1269), update the slash command items to include all available agents:

```typescript
if (composerTrigger.kind === "slash-command") {
  const agentCommands: Extract<ComposerCommandItem, { type: "slash-command" }>[] =
    availableAgents.length > 0
      ? availableAgents.map((agent) => ({
          id: `slash:${agent.name}`,
          type: "slash-command" as const,
          command: agent.name,
          label: `/${agent.name}`,
          description: agent.description ?? `Switch to ${agent.name} agent`,
        }))
      : [
          {
            id: "slash:plan",
            type: "slash-command",
            command: "plan",
            label: "/plan",
            description: "Switch this thread into plan mode",
          },
          {
            id: "slash:build",
            type: "slash-command",
            command: "build",
            label: "/build",
            description: "Switch this thread back to build mode",
          },
        ];

  const slashCommandItems = [
    {
      id: "slash:model",
      type: "slash-command",
      command: "model",
      label: "/model",
      description: "Switch response model for this thread",
    },
    ...agentCommands,
  ] satisfies ReadonlyArray<Extract<ComposerCommandItem, { type: "slash-command" }>>;
  // ... rest of filtering logic unchanged
}
```

- [ ] **Step 6: Update `ComposerSlashCommand` type and `parseStandaloneComposerSlashCommand`**

In `apps/web/src/composer-logic.ts`:

```typescript
// Before
export type ComposerSlashCommand = "model" | "plan" | "default";
const SLASH_COMMANDS: readonly ComposerSlashCommand[] = ["model", "plan", "default"];

// After — ComposerSlashCommand is now "model" or a string agent name
export type ComposerSlashCommand = "model" | (string & {});
```

Remove the static `SLASH_COMMANDS` array. The slash command matching in `detectComposerTrigger` needs to accept any `/word` as a potential slash command (the ChatView will filter to valid agents).

For `parseStandaloneComposerSlashCommand`, it now needs to accept any single-word slash command:

```typescript
export function parseStandaloneComposerSlashCommand(text: string): string | null {
  const match = /^\/(\w+)\s*$/i.exec(text.trim());
  if (!match || !match[1]) return null;
  const command = match[1].toLowerCase();
  if (command === "model") return null; // /model is handled differently
  return command;
}
```

- [ ] **Step 7: Update `ChatView.tsx` slash command selection handler**

In the `onComposerMenuItemSelected` callback (~line 3549-3568), update the slash command handling:

```typescript
if (item.type === "slash-command") {
  if (item.command === "model") {
    // existing model handling...
  }
  // Agent switch — use handleInteractionModeChange directly with the command name
  void handleInteractionModeChange(item.command);
  // ... rest of prompt replacement logic
}
```

- [ ] **Step 8: Run typecheck and tests**

Run: `bun typecheck && npx vitest run apps/web/src/`

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "feat: dynamic agent picker in composer from OpenCode harness"
```

---

### Task 5: Update the decider fix and remaining server references

Earlier we fixed the decider to use `command.interactionMode` instead of `targetThread.interactionMode`. Ensure all references to the old `"default"` literal are updated.

**Files:**

- Modify: `apps/server/src/orchestration/decider.ts` (already partly fixed)
- Modify: `apps/server/src/wsServer.ts:1090` (default interaction mode)
- Modify: `apps/server/src/github/Layers/GithubAppAutomation.ts` (default interaction mode)
- Modify: Various test files that hardcode `"default"`

- [ ] **Step 1: Update all `DEFAULT_PROVIDER_INTERACTION_MODE` usages**

Since the default changed from `"default"` to `"build"`, all imports of `DEFAULT_PROVIDER_INTERACTION_MODE` will automatically pick up the new value. Verify that no code compares against the literal string `"default"` expecting it to be the default mode.

Search for: `interactionMode: "default"` and `=== "default"` across the server codebase.

- [ ] **Step 2: Update test files**

Test files that hardcode `interactionMode: "default"` should be updated to `interactionMode: "build"` (or `DEFAULT_PROVIDER_INTERACTION_MODE`). This is a bulk find-replace.

- [ ] **Step 3: Run full test suite**

Run: `npx vitest run apps/server/ apps/web/`

- [ ] **Step 4: Run lint and format**

Run: `bun fmt && bun lint && bun typecheck`

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "chore: update default interaction mode references from 'default' to 'build'"
```

---

### Task 6: Update `composerDraftStore` and persistence

The draft store persists `interactionMode` per thread. With the widened type, the stored values need to work with arbitrary agent names.

**Files:**

- Modify: `apps/web/src/composerDraftStore.ts` (types should already work with `string`)
- Verify: `apps/server/src/persistence/` (SQLite stores `interaction_mode` as text — should be fine)

- [ ] **Step 1: Verify composerDraftStore compatibility**

Read `apps/web/src/composerDraftStore.ts` and verify that `interactionMode` is typed as `ProviderInteractionMode` (now `string`). No change should be needed since we widened the type at the source.

- [ ] **Step 2: Verify persistence layer compatibility**

The SQLite column `interaction_mode` stores text. Old rows will have `"default"`. New rows will have agent names like `"build"`, `"plan"`, `"explore"`. The OpenCode adapter already normalizes `"default"` → `"build"` (from Task 3). Verify this is sufficient.

- [ ] **Step 3: Run full check**

Run: `bun fmt && bun lint && bun typecheck`

- [ ] **Step 4: Commit if any changes**

```bash
git add -A
git commit -m "chore: verify draft store and persistence compatibility with agent names"
```
