/**
 * WebSocket transport for React Native.
 * Ported from apps/web/src/wsTransport.ts with RN-compatible APIs.
 *
 * Protocol: JSON messages over WebSocket.
 * - Client sends: { id: string, body: { _tag: string, ...params } }
 * - Server responds: { id: string, result?: unknown, error?: { message: string } }
 * - Server pushes: { type: "push", sequence: number, channel: string, data: unknown }
 */

type PushListener = (message: PushMessage) => void;

interface PendingRequest {
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout> | null;
}

interface RequestOptions {
  readonly timeoutMs?: number | null;
}

export type TransportState = "connecting" | "open" | "reconnecting" | "closed" | "disposed";

export interface PushMessage {
  type: "push";
  sequence: number;
  channel: string;
  data: unknown;
}

interface ResponseMessage {
  id: string;
  result?: unknown;
  error?: { message: string };
}

type ServerMessage = ResponseMessage | PushMessage;

const REQUEST_TIMEOUT_MS = 60_000;
const RECONNECT_DELAYS_MS = [500, 1_000, 2_000, 4_000, 8_000];

function isPushMessage(value: ServerMessage): value is PushMessage {
  return "type" in value && (value as PushMessage).type === "push";
}

function isResponseMessage(value: ServerMessage): value is ResponseMessage {
  return "id" in value && typeof (value as ResponseMessage).id === "string";
}

function parseServerMessage(raw: string): ServerMessage | null {
  try {
    const parsed = JSON.parse(raw) as ServerMessage;
    if (isPushMessage(parsed) || isResponseMessage(parsed)) {
      return parsed;
    }
    return null;
  } catch {
    return null;
  }
}

export type StateChangeListener = (state: TransportState) => void;

export class WsTransport {
  private ws: WebSocket | null = null;
  private nextId = 1;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly listeners = new Map<string, Set<PushListener>>();
  private readonly latestPushByChannel = new Map<string, PushMessage>();
  private readonly outboundQueue: string[] = [];
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;
  private state: TransportState = "connecting";
  private readonly url: string;
  private readonly stateListeners = new Set<StateChangeListener>();

  constructor(url: string) {
    this.url = url;
    this.connect();
  }

  getState(): TransportState {
    return this.state;
  }

  onStateChange(listener: StateChangeListener): () => void {
    this.stateListeners.add(listener);
    return () => {
      this.stateListeners.delete(listener);
    };
  }

  private setState(newState: TransportState) {
    if (this.state === newState) return;
    this.state = newState;
    for (const listener of this.stateListeners) {
      try {
        listener(newState);
      } catch {
        // swallow
      }
    }
  }

  async request<T = unknown>(
    method: string,
    params?: unknown,
    options?: RequestOptions,
  ): Promise<T> {
    if (typeof method !== "string" || method.length === 0) {
      throw new Error("Request method is required");
    }

    const id = String(this.nextId++);
    const body =
      params != null ? { ...(params as Record<string, unknown>), _tag: method } : { _tag: method };
    const encoded = JSON.stringify({ id, body });

    return new Promise<T>((resolve, reject) => {
      const timeoutMs = options?.timeoutMs === undefined ? REQUEST_TIMEOUT_MS : options.timeoutMs;
      const timeout =
        timeoutMs === null
          ? null
          : setTimeout(() => {
              this.pending.delete(id);
              reject(new Error(`Request timed out: ${method}`));
            }, timeoutMs);

      this.pending.set(id, {
        resolve: resolve as (result: unknown) => void,
        reject,
        timeout,
      });

      this.send(encoded);
    });
  }

  subscribe(channel: string, listener: PushListener): () => void {
    let channelListeners = this.listeners.get(channel);
    if (!channelListeners) {
      channelListeners = new Set<PushListener>();
      this.listeners.set(channel, channelListeners);
    }
    channelListeners.add(listener);
    return () => {
      channelListeners?.delete(listener);
      if (channelListeners?.size === 0) {
        this.listeners.delete(channel);
      }
    };
  }

  getLatestPush(channel: string): PushMessage | null {
    return this.latestPushByChannel.get(channel) ?? null;
  }

  dispose() {
    this.disposed = true;
    this.setState("disposed");
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    for (const pending of this.pending.values()) {
      if (pending.timeout !== null) {
        clearTimeout(pending.timeout);
      }
      pending.reject(new Error("Transport disposed"));
    }
    this.pending.clear();
    this.outboundQueue.length = 0;
    this.ws?.close();
    this.ws = null;
  }

  private connect() {
    if (this.disposed) return;

    this.setState(this.reconnectAttempt > 0 ? "reconnecting" : "connecting");
    const ws = new WebSocket(this.url);

    ws.addEventListener("open", () => {
      this.ws = ws;
      this.setState("open");
      this.reconnectAttempt = 0;
      this.flushQueue();
    });

    ws.addEventListener("message", (event) => {
      const data = typeof event.data === "string" ? event.data : null;
      if (data) {
        this.handleMessage(data);
      }
    });

    ws.addEventListener("close", () => {
      if (this.ws === ws) {
        this.ws = null;
        this.outboundQueue.length = 0;
        for (const [id, pending] of this.pending.entries()) {
          if (pending.timeout !== null) {
            clearTimeout(pending.timeout);
          }
          this.pending.delete(id);
          pending.reject(new Error("WebSocket connection closed."));
        }
      }
      if (this.disposed) {
        this.setState("disposed");
        return;
      }
      this.setState("closed");
      this.scheduleReconnect();
    });

    ws.addEventListener("error", () => {
      // close event will follow
    });
  }

  private handleMessage(raw: string) {
    const message = parseServerMessage(raw);
    if (!message) return;

    if (isPushMessage(message)) {
      this.latestPushByChannel.set(message.channel, message);
      const channelListeners = this.listeners.get(message.channel);
      if (channelListeners) {
        for (const listener of channelListeners) {
          try {
            listener(message);
          } catch {
            // swallow
          }
        }
      }
      return;
    }

    if (!isResponseMessage(message)) return;

    const pending = this.pending.get(message.id);
    if (!pending) return;

    if (pending.timeout !== null) {
      clearTimeout(pending.timeout);
    }
    this.pending.delete(message.id);

    if (message.error) {
      pending.reject(new Error(message.error.message));
      return;
    }

    pending.resolve(message.result);
  }

  private send(encodedMessage: string) {
    if (this.disposed) return;
    this.outboundQueue.push(encodedMessage);
    try {
      this.flushQueue();
    } catch {
      // queued for retry on reconnect
    }
  }

  private flushQueue() {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

    while (this.outboundQueue.length > 0) {
      const message = this.outboundQueue.shift();
      if (!message) continue;
      try {
        this.ws.send(message);
      } catch {
        this.outboundQueue.unshift(message);
        return;
      }
    }
  }

  private scheduleReconnect() {
    if (this.disposed || this.reconnectTimer !== null) return;

    const delay =
      RECONNECT_DELAYS_MS[Math.min(this.reconnectAttempt, RECONNECT_DELAYS_MS.length - 1)] ??
      RECONNECT_DELAYS_MS[0]!;

    this.reconnectAttempt += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }
}
