import { WebSocketServer } from "ws";
import { createServer } from "http";

const PORT = 8787;
let commitSeq = 0;
/** @type {Map<string, import("ws").WebSocket>} */
const sockets = new Map();

/** @type {Array<{ strokeId: string, color: string, width: number, points: unknown[], authorClientId: string, commitIndex: number }>} */
const log = [];

function broadcast(obj, exceptId) {
  const raw = JSON.stringify(obj);
  for (const [id, ws] of sockets) {
    if (id === exceptId) continue;
    if (ws.readyState === 1) ws.send(raw);
  }
}

const server = createServer((_req, res) => {
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("mock gateway — connect via ws\n");
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

  ws.send(
    JSON.stringify({
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
    }),
  );

  ws.on("message", (data) => {
    let msg;
    try {
      msg = JSON.parse(String(data));
    } catch {
      return;
    }
    if (msg.type === "hello") {
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
  console.log(`mock gateway http://localhost:${PORT}  ws ws://localhost:${PORT}/ws`);
});
