import type { ClientMessage, ServerMessage, Stroke } from "../types";

type Handlers = {
  onOpen?: () => void;
  onClose?: () => void;
  onWelcome?: (clientId: string, lastCommitIndex: number) => void;
  onStrokeCommitted?: (stroke: Stroke) => void;
  onSnapshot?: (strokes: Stroke[], lastCommitIndex: number) => void;
  onError?: (code: string, message: string) => void;
};

const PROTOCOL_VERSION = 1;
const MAX_BACKOFF_MS = 30_000;
const INITIAL_BACKOFF_MS = 500;

function parseServerMessage(raw: unknown): ServerMessage | null {
  if (!raw || typeof raw !== "object") return null;
  const m = raw as Record<string, unknown>;
  if (m.type === "welcome" && typeof m.clientId === "string" && typeof m.lastCommitIndex === "number") {
    return {
      type: "welcome",
      clientId: m.clientId,
      lastCommitIndex: m.lastCommitIndex,
    };
  }
  if (m.type === "stroke.committed" && typeof m.strokeId === "string" && typeof m.commitIndex === "number") {
    return {
      type: "stroke.committed",
      strokeId: m.strokeId,
      color: String(m.color ?? "#000000"),
      width: typeof m.width === "number" ? m.width : 3,
      points: Array.isArray(m.points) ? (m.points as Stroke["points"]) : [],
      authorClientId: typeof m.authorClientId === "string" ? m.authorClientId : undefined,
      commitIndex: m.commitIndex,
    };
  }
  if (m.type === "state.snapshot" && Array.isArray(m.strokes) && typeof m.lastCommitIndex === "number") {
    return {
      type: "state.snapshot",
      strokes: m.strokes as Stroke[],
      lastCommitIndex: m.lastCommitIndex,
    };
  }
  if (m.type === "error" && typeof m.code === "string" && typeof m.message === "string") {
    return { type: "error", code: m.code, message: m.message };
  }
  return null;
}

export class GatewayClient {
  private ws: WebSocket | null = null;
  private url: string;
  private handlers: Handlers;
  private lastSeenCommitIndex = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private backoffMs = INITIAL_BACKOFF_MS;
  private shouldConnect = false;
  private clientId: string | null = null;

  constructor(url: string, handlers: Handlers = {}) {
    this.url = url;
    this.handlers = handlers;
  }

  get connected() {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  get assignedClientId() {
    return this.clientId;
  }

  setLastSeenCommitIndex(n: number) {
    this.lastSeenCommitIndex = n;
  }

  connect() {
    this.shouldConnect = true;
    this.openSocket();
  }

  disconnect() {
    this.shouldConnect = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.ws?.close();
    this.ws = null;
  }

  send(msg: ClientMessage) {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify(msg));
  }

  sendStrokeAppend(stroke: Omit<Stroke, "commitIndex">) {
    this.send({
      type: "stroke.append",
      strokeId: stroke.strokeId,
      color: stroke.color,
      width: stroke.width,
      points: stroke.points,
    });
  }

  private openSocket() {
    if (!this.shouldConnect) return;
    if (this.ws?.readyState === WebSocket.OPEN || this.ws?.readyState === WebSocket.CONNECTING) return;

    const socket = new WebSocket(this.url);
    this.ws = socket;

    socket.addEventListener("open", () => {
      this.backoffMs = INITIAL_BACKOFF_MS;
      this.handlers.onOpen?.();
      const hello: ClientMessage = {
        type: "hello",
        lastSeenCommitIndex: this.lastSeenCommitIndex,
        protocolVersion: PROTOCOL_VERSION,
      };
      socket.send(JSON.stringify(hello));
    });

    socket.addEventListener("message", (ev) => {
      let data: unknown;
      try {
        data = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      const msg = parseServerMessage(data);
      if (!msg) return;
      if (msg.type === "welcome") {
        this.clientId = msg.clientId;
        this.lastSeenCommitIndex = msg.lastCommitIndex;
        this.handlers.onWelcome?.(msg.clientId, msg.lastCommitIndex);
      } else if (msg.type === "stroke.committed") {
        this.lastSeenCommitIndex = Math.max(this.lastSeenCommitIndex, msg.commitIndex);
        this.handlers.onStrokeCommitted?.({
          strokeId: msg.strokeId,
          color: msg.color,
          width: msg.width,
          points: msg.points,
          authorClientId: msg.authorClientId,
          commitIndex: msg.commitIndex,
        });
      } else if (msg.type === "state.snapshot") {
        this.lastSeenCommitIndex = msg.lastCommitIndex;
        this.handlers.onSnapshot?.(msg.strokes, msg.lastCommitIndex);
      } else if (msg.type === "error") {
        this.handlers.onError?.(msg.code, msg.message);
      }
    });

    socket.addEventListener("close", () => {
      this.ws = null;
      this.handlers.onClose?.();
      this.scheduleReconnect();
    });

    socket.addEventListener("error", () => {
      socket.close();
    });
  }

  private scheduleReconnect() {
    if (!this.shouldConnect) return;
    if (this.reconnectTimer) return;
    const delay = this.backoffMs;
    this.backoffMs = Math.min(this.backoffMs * 2, MAX_BACKOFF_MS);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.openSocket();
    }, delay);
  }
}
