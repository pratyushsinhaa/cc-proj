import { WebSocketServer } from "ws";
import { createServer } from "http";

const PORT = 8787;
let commitSeq = 0;
let term = 1;
let leaderId = "replica-a";

/** @type {Map<string, import("ws").WebSocket>} */
const sockets = new Map();

/** @type {Array<{ strokeId: string, color: string, width: number, points: unknown[], authorClientId: string, commitIndex: number }>} */
const log = [];

function broadcastToAll(obj) {
  const raw = JSON.stringify(obj);
  for (const [, ws] of sockets) {
    if (ws.readyState === 1) ws.send(raw);
  }
}

function snapshotPayload() {
  return {
    type: "state.snapshot",
    strokes: log.map((s) => ({
      strokeId: s.strokeId,
      color: s.color,
      width: s.width,
      points: s.points,
      authorClientId: s.authorClientId,
      commitIndex: s.commitIndex,
    })),
    lastCommitIndex: commitSeq,
  };
}

function sendHint(ws) {
  ws.send(
    JSON.stringify({
      type: "cluster.hint",
      leaderId,
      term,
      role: "leader",
    }),
  );
}

function simulateFailover() {
  term += 1;
  leaderId = leaderId === "replica-a" ? "replica-b" : "replica-a";
  broadcastToAll({
    type: "cluster.transition",
    reason: "leader_failover",
    leaderId,
    term,
    phase: "handover",
  });
  setTimeout(() => {
    for (const ws of sockets.values()) {
      try {
        ws.close(4001, "leader-transition");
      } catch {
        /* ignore */
      }
    }
  }, 80);
}

const server = createServer((req, res) => {
  if (req.method === "POST" && req.url === "/simulate-failover") {
    simulateFailover();
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("failover broadcast + disconnect\n");
    return;
  }
  if (req.method === "GET" && req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        ok: true,
        commitSeq,
        term,
        leaderId,
        clients: sockets.size,
      }),
    );
    return;
  }
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end(
    "mock gateway\n  ws: ws://localhost:" +
      PORT +
      "/ws\n  POST /simulate-failover — test Week 3 client reconnect\n  GET /health\n",
  );
});

const wss = new WebSocketServer({ server, path: "/ws" });

wss.on("connection", (ws) => {
  const clientId = `c-${Math.random().toString(36).slice(2, 10)}`;
  sockets.set(clientId, ws);

  ws.send(
    JSON.stringify({
      type: "welcome",
      clientId,
      lastCommitIndex: commitSeq,
    }),
  );

  ws.send(JSON.stringify(snapshotPayload()));
  sendHint(ws);

  ws.on("message", (data) => {
    let msg;
    try {
      msg = JSON.parse(String(data));
    } catch {
      return;
    }
    if (msg.type === "hello") {
      const lastSeen =
        typeof msg.lastSeenCommitIndex === "number" ? msg.lastSeenCommitIndex : 0;
      if (lastSeen < commitSeq) {
        ws.send(JSON.stringify(snapshotPayload()));
      }
      return;
    }
    if (msg.type === "stroke.append" && msg.strokeId && Array.isArray(msg.points)) {
      commitSeq += 1;
      const entry = {
        strokeId: msg.strokeId,
        color: String(msg.color ?? "#000"),
        width: typeof msg.width === "number" ? msg.width : 3,
        points: msg.points,
        authorClientId: clientId,
        commitIndex: commitSeq,
      };
      log.push(entry);
      const committed = {
        type: "stroke.committed",
        strokeId: entry.strokeId,
        color: entry.color,
        width: entry.width,
        points: entry.points,
        authorClientId: entry.authorClientId,
        commitIndex: entry.commitIndex,
      };
      const raw = JSON.stringify(committed);
      for (const [, s] of sockets) {
        if (s.readyState === 1) s.send(raw);
      }
    }
  });

  ws.on("close", () => {
    sockets.delete(clientId);
  });
});

server.listen(PORT, () => {
  console.log(`mock gateway http://localhost:${PORT}`);
  console.log(`  ws ws://localhost:${PORT}/ws`);
  console.log(`  POST http://localhost:${PORT}/simulate-failover`);
});
