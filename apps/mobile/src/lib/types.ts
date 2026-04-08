// Lightweight types for mobile app, mirroring key contracts from @t3tools/contracts
// without pulling in the full effect/Schema dependency tree.

export type ProviderKind = "codex" | "claudeAgent" | "opencode";
export type RuntimeMode = "approval-required" | "full-access";
export type ProviderInteractionMode = "default" | "plan";
export type OrchestrationSessionStatus =
  | "starting"
  | "running"
  | "error"
  | "ready"
  | "interrupted"
  | "idle"
  | "stopped";

export type SessionPhase = "disconnected" | "connecting" | "ready" | "running";

export interface ModelSelection {
  provider: ProviderKind;
  model: string;
  options?: Record<string, unknown>;
}

export interface ChatAttachment {
  type: "image";
  id: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
  previewUrl?: string;
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "system";
  text: string;
  attachments?: ChatAttachment[];
  createdAt: string;
  completedAt?: string;
  streaming: boolean;
}

export interface ThreadSession {
  provider: ProviderKind;
  status: SessionPhase | "error" | "closed";
  activeTurnId?: string;
  createdAt: string;
  updatedAt: string;
  lastError?: string;
  orchestrationStatus: OrchestrationSessionStatus;
}

export interface LatestTurn {
  turnId: string;
  startedAt: string;
  completedAt: string | null;
  sourceProposedPlan?: {
    threadId: string;
    planId: string;
  } | null;
}

export interface ThreadActivity {
  id: string;
  kind: string;
  turnId: string | null;
  summary: string;
  tone: "thinking" | "tool" | "info" | "error" | "approval";
  createdAt: string;
  sequence?: number;
  payload?: Record<string, unknown> | null;
}

export interface Thread {
  id: string;
  projectId: string;
  title: string;
  modelSelection: ModelSelection;
  runtimeMode: RuntimeMode;
  interactionMode: ProviderInteractionMode;
  session: ThreadSession | null;
  messages: ChatMessage[];
  error: string | null;
  createdAt: string;
  archivedAt: string | null;
  updatedAt?: string;
  latestTurn: LatestTurn | null;
  branch: string | null;
  worktreePath: string | null;
  activities: ThreadActivity[];
}

export interface Project {
  id: string;
  name: string;
  cwd: string;
  defaultModelSelection: ModelSelection | null;
  createdAt?: string;
  updatedAt?: string;
}

export interface WsWelcomePayload {
  cwd: string;
  projectName: string;
  bootstrapProjectId?: string;
  bootstrapThreadId?: string;
}

export interface ServerConfig {
  version: string;
  cwd: string;
  providers: Array<{
    kind: ProviderKind;
    available: boolean;
  }>;
  [key: string]: unknown;
}

export interface WorkLogEntry {
  id: string;
  createdAt: string;
  label: string;
  detail?: string;
  command?: string;
  tone: "thinking" | "tool" | "info" | "error";
}
