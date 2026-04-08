/**
 * Main application state store.
 * Manages projects, threads, and connection lifecycle.
 */

import { create } from "zustand";
import type { Project, Thread, ChatMessage, WsWelcomePayload, ThreadActivity } from "./types";
import { WsTransport, type TransportState } from "./wsTransport";
import { ServerApi, type OrchestrationSnapshot } from "./api";

interface AppState {
  // Connection
  transport: WsTransport | null;
  api: ServerApi | null;
  transportState: TransportState;
  welcome: WsWelcomePayload | null;

  // Data
  projects: Project[];
  threads: Thread[];
  hydrated: boolean;

  // Actions
  connect: (url: string) => void;
  disconnect: () => void;
  syncSnapshot: (snapshot: OrchestrationSnapshot) => void;
  handleDomainEvent: (event: unknown) => void;
}

function mapSnapshotToState(snapshot: OrchestrationSnapshot): {
  projects: Project[];
  threads: Thread[];
} {
  const projects: Project[] = snapshot.projects
    .filter((p) => p.deletedAt === null)
    .map((p) => ({
      id: p.id,
      name: p.title,
      cwd: p.workspaceRoot,
      defaultModelSelection: p.defaultModelSelection
        ? {
            provider: p.defaultModelSelection.provider as Project["defaultModelSelection"] extends
              | null
              | (infer U)
              ? U extends { provider: infer P }
                ? P
                : never
              : never,
            model: p.defaultModelSelection.model,
          }
        : null,
      createdAt: p.createdAt,
      updatedAt: p.updatedAt,
    }));

  const threads: Thread[] = snapshot.threads
    .filter((t) => t.deletedAt === null)
    .map((t) => ({
      id: t.id,
      projectId: t.projectId,
      title: t.title,
      modelSelection: {
        provider: t.modelSelection.provider as Thread["modelSelection"]["provider"],
        model: t.modelSelection.model,
      },
      runtimeMode: t.runtimeMode as Thread["runtimeMode"],
      interactionMode: t.interactionMode as Thread["interactionMode"],
      session: t.session
        ? {
            provider: (t.session.providerName ?? "codex") as Thread["session"] extends
              | null
              | (infer U)
              ? U extends { provider: infer P }
                ? P
                : never
              : never,
            status: mapSessionStatus(t.session.status),
            activeTurnId: t.session.activeTurnId ?? undefined,
            createdAt: t.session.updatedAt,
            updatedAt: t.session.updatedAt,
            orchestrationStatus: t.session.status as Thread["session"] extends null | (infer U)
              ? U extends { orchestrationStatus: infer O }
                ? O
                : never
              : never,
            ...(t.session.lastError ? { lastError: t.session.lastError } : {}),
          }
        : null,
      messages: t.messages.map(
        (m): ChatMessage => ({
          id: m.id,
          role: m.role,
          text: m.text,
          createdAt: m.createdAt,
          streaming: m.streaming,
          ...(!m.streaming ? { completedAt: m.updatedAt } : {}),
        }),
      ),
      error: t.session?.lastError ?? null,
      createdAt: t.createdAt,
      archivedAt: t.archivedAt,
      updatedAt: t.updatedAt,
      latestTurn: t.latestTurn,
      branch: t.branch,
      worktreePath: t.worktreePath,
      activities: t.activities as ThreadActivity[],
    }));

  return { projects, threads };
}

function mapSessionStatus(status: string): "connecting" | "ready" | "running" | "error" | "closed" {
  switch (status) {
    case "starting":
      return "connecting";
    case "running":
      return "running";
    case "error":
      return "error";
    case "ready":
    case "interrupted":
      return "ready";
    case "idle":
    case "stopped":
      return "closed";
    default:
      return "closed";
  }
}

export const useAppStore = create<AppState>((set, get) => ({
  transport: null,
  api: null,
  transportState: "closed",
  welcome: null,
  projects: [],
  threads: [],
  hydrated: false,

  connect: (url: string) => {
    const current = get();
    if (current.transport) {
      current.transport.dispose();
    }

    const transport = new WsTransport(url);
    const api = new ServerApi(transport);

    const unsubState = transport.onStateChange((state) => {
      set({ transportState: state });

      // Fetch snapshot when connected
      if (state === "open") {
        api
          .getSnapshot()
          .then((snapshot) => {
            get().syncSnapshot(snapshot);
          })
          .catch(() => {
            // Will retry on reconnect
          });
      }
    });

    const unsubWelcome = api.onWelcome((payload) => {
      set({ welcome: payload });
    });

    const unsubDomain = api.onDomainEvent((event) => {
      get().handleDomainEvent(event);
    });

    // Store cleanup functions on the transport for disposal
    const originalDispose = transport.dispose.bind(transport);
    transport.dispose = () => {
      unsubState();
      unsubWelcome();
      unsubDomain();
      originalDispose();
    };

    set({
      transport,
      api,
      transportState: transport.getState(),
      welcome: null,
      projects: [],
      threads: [],
      hydrated: false,
    });
  },

  disconnect: () => {
    const { transport } = get();
    if (transport) {
      transport.dispose();
    }
    set({
      transport: null,
      api: null,
      transportState: "closed",
      welcome: null,
      projects: [],
      threads: [],
      hydrated: false,
    });
  },

  syncSnapshot: (snapshot) => {
    const { projects, threads } = mapSnapshotToState(snapshot);
    set({ projects, threads, hydrated: true });
  },

  handleDomainEvent: (_event) => {
    // On any domain event, re-fetch the full snapshot for simplicity.
    // This is less efficient than incremental updates but much simpler
    // and perfectly adequate for a mobile companion app.
    const { api } = get();
    if (!api) return;

    api
      .getSnapshot()
      .then((snapshot) => {
        get().syncSnapshot(snapshot);
      })
      .catch(() => {
        // Will retry on next event
      });
  },
}));
