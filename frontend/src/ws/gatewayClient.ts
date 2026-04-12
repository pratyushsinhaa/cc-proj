import type { ClientMessage, ServerMessage, Stroke } from "../types";

type Handlers = {
  onOpen?: () => void;
  onClose?: () => void;
  onWelcome?: (clientId: string, lastCommitIndex: number) => void;
  onStrokeCommitted?: (stroke: Stroke) => void;
  onSnapshot?: (strokes: Stroke[], lastCommitIndex: number) => void;
  onClusterHint?: (leaderId: string, term: number, role?: string) => void;
  onClusterTransition?: (reason: string, leaderId: string, term: number, phase?: string) => void;
  onReconnecting?: (delayMs: number) => void;
  onQueueChange?: (pendingOutbound: number) => void;
  onError?: (code: string, message: string) => void;
};

const MAX_BACKOFF_MS = 30_000;
const INITIAL_BACKOFF_MS = 500;
const MAX_PENDING_OUTBOUND = 200;

export type StrokePayload = Omit<Stroke, "commitIndex" | "authorClientId">;

function parseServerMessage(raw: unknown): ServerMessage | null {
  if (!raw || typeof raw !== "object") return null;
  const m = raw as Record<string, unknown>;
  if (m.type === "WELCOME") {
    return {
      type: "welcome",
      clientId: String(m.clientId ?? "browser-client"),
      lastCommitIndex: typeof m.commitIndex === "number" ? m.commitIndex : 0,
    };
  }
  if (m.type === "DRAW_COMMITTED" && m.operation && typeof m.operation === "object") {
    const op = m.operation as Record<string, unknown>;
    const payload = (op.payload && typeof op.payload === "object" ? op.payload : {}) as Record<string, unknown>;
    let points = Array.isArray(payload.points) ? (payload.points as Stroke["points"]) : [];
    if (!points.length && typeof payload.x0 === "number" && typeof payload.y0 === "number" && typeof payload.x1 === "number" && typeof payload.y1 === "number") {
      points = [
        { x: payload.x0 as number, y: payload.y0 as number },
        { x: payload.x1 as number, y: payload.y1 as number },
      ];
    }
    return {
      type: "stroke.committed",
      strokeId: String(payload.strokeId ?? `stroke-${String(op.index ?? Date.now())}`),
      color: String(payload.color ?? "#000000"),
      width: typeof payload.width === "number" ? payload.width : 2,
      points,
      authorClientId: typeof payload.authorClientId === "string" ? payload.authorClientId : undefined,
      commitIndex: typeof op.index === "number" ? op.index : 0,
    };
  }
  if (m.type === "CANVAS_SNAPSHOT") {
    const operations = Array.isArray(m.operations) ? (m.operations as Array<Record<string, unknown>>) : [];
    const strokes: Stroke[] = operations.map((op) => {
      const payload = (op.payload && typeof op.payload === "object" ? op.payload : {}) as Record<string, unknown>;
      let points = Array.isArray(payload.points) ? (payload.points as Stroke["points"]) : [];
      if (!points.length && typeof payload.x0 === "number" && typeof payload.y0 === "number" && typeof payload.x1 === "number" && typeof payload.y1 === "number") {
        points = [
          { x: payload.x0 as number, y: payload.y0 as number },
          { x: payload.x1 as number, y: payload.y1 as number },
        ];
      }
      return {
        strokeId: String(payload.strokeId ?? `stroke-${String(op.index ?? 0)}`),
        color: String(payload.color ?? "#000000"),
        width: typeof payload.width === "number" ? payload.width : 2,
        points,
        commitIndex: typeof op.index === "number" ? op.index : 0,
      };
    });
    return {
      type: "state.snapshot",
      strokes,
      lastCommitIndex: typeof m.commitIndex === "number" ? m.commitIndex : 0,
    };
  }
  if (m.type === "LEADER_UPDATE") {
    const leader = (m.leader && typeof m.leader === "object" ? m.leader : null) as Record<string, unknown> | null;
    const leaderId = leader && typeof leader.id === "string" ? leader.id : "unknown";
    const term = leader && typeof leader.term === "number" ? leader.term : 0;
    return {
      type: "cluster.hint",
      leaderId,
      term,
    };
  }
  if (m.type === "ERROR") {
    return {
      type: "error",
      code: "gateway_error",
      message: String(m.message ?? "Unknown gateway error"),
    };
  }
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
  if (m.type === "cluster.hint" && typeof m.leaderId === "string" && typeof m.term === "number") {
    return {
      type: "cluster.hint",
      leaderId: m.leaderId,
      term: m.term,
      role: typeof m.role === "string" ? m.role : undefined,
    };
  }
  if (
    m.type === "cluster.transition" &&
    typeof m.reason === "string" &&
    typeof m.leaderId === "string" &&
    typeof m.term === "number"
  ) {
    return {
      type: "cluster.transition",
      reason: m.reason,
      leaderId: m.leaderId,
      term: m.term,
      phase: typeof m.phase === "string" ? m.phase : undefined,
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
  private handshakeComplete = false;
  private pendingOutbound: StrokePayload[] = [];

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

  get outboundQueued() {
    return this.pendingOutbound.length;
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
    this.handshakeComplete = false;
    this.ws?.close();
    this.ws = null;
  }

  send(msg: ClientMessage) {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify(msg));
  }

  sendStrokeAppend(stroke: StrokePayload) {
    if (this.ws?.readyState === WebSocket.OPEN && this.handshakeComplete) {
      this.sendAppendNow(stroke);
      return;
    }
    while (this.pendingOutbound.length >= MAX_PENDING_OUTBOUND) {
      this.pendingOutbound.shift();
    }
    this.pendingOutbound.push(stroke);
    this.handlers.onQueueChange?.(this.pendingOutbound.length);
  }

  private sendAppendNow(stroke: StrokePayload) {
    const msg: ClientMessage = {
      type: "DRAW",
      payload: stroke,
    };
    this.send(msg);
  }

  private flushPendingOutbound() {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN || !this.handshakeComplete) return;
    while (this.pendingOutbound.length > 0) {
      const s = this.pendingOutbound.shift();
      if (s) this.sendAppendNow(s);
    }
    this.handlers.onQueueChange?.(0);
  }

  private openSocket() {
    if (!this.shouldConnect) return;
    if (this.ws?.readyState === WebSocket.OPEN || this.ws?.readyState === WebSocket.CONNECTING) return;

    const socket = new WebSocket(this.url);
    this.ws = socket;
    this.handshakeComplete = false;

    socket.addEventListener("open", () => {
      this.backoffMs = INITIAL_BACKOFF_MS;
      this.handshakeComplete = true;
      this.handlers.onOpen?.();
      this.flushPendingOutbound();
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
        this.handshakeComplete = true;
        this.handlers.onWelcome?.(msg.clientId, msg.lastCommitIndex);
        this.flushPendingOutbound();
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
      } else if (msg.type === "cluster.hint") {
        this.handlers.onClusterHint?.(msg.leaderId, msg.term, msg.role);
      } else if (msg.type === "cluster.transition") {
        this.handlers.onClusterTransition?.(msg.reason, msg.leaderId, msg.term, msg.phase);
      } else if (msg.type === "error") {
        this.handlers.onError?.(msg.code, msg.message);
      }
    });

    socket.addEventListener("close", () => {
      this.ws = null;
      this.handshakeComplete = false;
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
    this.handlers.onReconnecting?.(delay);
    this.backoffMs = Math.min(this.backoffMs * 2, MAX_BACKOFF_MS);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.openSocket();
    }, delay);
  }
}
