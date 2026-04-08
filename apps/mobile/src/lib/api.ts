/**
 * High-level API layer over WsTransport.
 * Provides typed methods for orchestration commands used by the mobile app.
 */

import {
  WS_CHANNELS,
  ORCHESTRATION_WS_METHODS,
  ORCHESTRATION_WS_CHANNELS,
  WS_METHODS,
} from "./constants";
import type { PushMessage, WsTransport } from "./wsTransport";
import type { WsWelcomePayload, ServerConfig } from "./types";

export interface OrchestrationSnapshot {
  projects: Array<{
    id: string;
    title: string;
    workspaceRoot: string;
    defaultModelSelection: {
      provider: string;
      model: string;
    } | null;
    createdAt: string;
    updatedAt: string;
    deletedAt: string | null;
    scripts: Array<{ name: string; command: string }>;
  }>;
  threads: Array<{
    id: string;
    projectId: string;
    title: string;
    modelSelection: { provider: string; model: string };
    runtimeMode: string;
    interactionMode: string;
    session: {
      providerName: string | null;
      status: string;
      activeTurnId: string | null;
      updatedAt: string;
      lastError?: string | null;
    } | null;
    messages: Array<{
      id: string;
      role: "user" | "assistant" | "system";
      text: string;
      createdAt: string;
      updatedAt: string;
      streaming: boolean;
      attachments?: Array<{
        id: string;
        name: string;
        mimeType: string;
        sizeBytes: number;
      }>;
    }>;
    proposedPlans: Array<{
      id: string;
      turnId: string | null;
      planMarkdown: string;
      implementedAt: string | null;
      implementationThreadId: string | null;
      createdAt: string;
      updatedAt: string;
    }>;
    createdAt: string;
    archivedAt: string | null;
    updatedAt: string;
    deletedAt: string | null;
    latestTurn: {
      turnId: string;
      startedAt: string;
      completedAt: string | null;
    } | null;
    branch: string | null;
    worktreePath: string | null;
    checkpoints: Array<Record<string, unknown>>;
    activities: Array<{
      id: string;
      kind: string;
      turnId: string | null;
      summary: string;
      tone: string;
      createdAt: string;
      sequence?: number;
      payload?: Record<string, unknown> | null;
    }>;
  }>;
}

/** Orchestration command types matching the server protocol */
export type OrchestrationCommand =
  | {
      _tag: "CreateThread";
      projectId: string;
      modelSelection: { provider: string; model: string };
      runtimeMode: string;
    }
  | {
      _tag: "SendMessage";
      threadId: string;
      text: string;
    }
  | {
      _tag: "CancelTurn";
      threadId: string;
    }
  | {
      _tag: "ArchiveThread";
      threadId: string;
    }
  | {
      _tag: "UnarchiveThread";
      threadId: string;
    }
  | {
      _tag: "RespondToApproval";
      threadId: string;
      requestId: string;
      approved: boolean;
    }
  | {
      _tag: "RespondToUserInput";
      threadId: string;
      requestId: string;
      responses: Array<{ questionId: string; selectedOptions: string[] }>;
    };

export class ServerApi {
  constructor(private readonly transport: WsTransport) {}

  getSnapshot(): Promise<OrchestrationSnapshot> {
    return this.transport.request(ORCHESTRATION_WS_METHODS.getSnapshot);
  }

  dispatchCommand(command: OrchestrationCommand): Promise<{ sequence: number }> {
    return this.transport.request(ORCHESTRATION_WS_METHODS.dispatchCommand, { command });
  }

  replayEvents(fromSequenceExclusive: number): Promise<unknown[]> {
    return this.transport.request(ORCHESTRATION_WS_METHODS.replayEvents, {
      fromSequenceExclusive,
    });
  }

  getConfig(): Promise<ServerConfig> {
    return this.transport.request(WS_METHODS.serverGetConfig);
  }

  onWelcome(callback: (payload: WsWelcomePayload) => void): () => void {
    return this.transport.subscribe(WS_CHANNELS.serverWelcome, (msg: PushMessage) => {
      callback(msg.data as WsWelcomePayload);
    });
  }

  onDomainEvent(callback: (event: unknown) => void): () => void {
    return this.transport.subscribe(ORCHESTRATION_WS_CHANNELS.domainEvent, (msg: PushMessage) => {
      callback(msg.data);
    });
  }
}
