import http from 'node:http';
import express from 'express';
import cors from 'cors';
import axios from 'axios';
import { WebSocketServer } from 'ws';

const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' }));
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const PORT = Number(process.env.PORT || 8080);
const REPLICAS = parseReplicaMap(process.env.REPLICA_URLS || '{}');
const REQUEST_TIMEOUT_MS = Number(process.env.REQUEST_TIMEOUT_MS || 1000);
const LEADER_DISCOVERY_MS = Number(process.env.LEADER_DISCOVERY_MS || 1500);
const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS || 500);

const runtime = {
  leader: null,
  term: 0,
  clients: new Set(),
  operationCursor: 0
};

function parseReplicaMap(rawValue) {
  try {
    const parsed = JSON.parse(rawValue);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {};
    }
    return parsed;
  } catch {
    return {};
  }
}

function generateRequestId() {
  const random = Math.floor(Math.random() * 1_000_000)
    .toString()
    .padStart(6, '0');
  return `gw-${Date.now()}-${random}`;
}

function validateDrawPayload(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return 'DRAW payload must be a JSON object';
  }
  return null;
}

function logEvent(message, data = {}) {
  console.log(
    JSON.stringify({
      ts: new Date().toISOString(),
      service: 'gateway',
      message,
      ...data
    })
  );
}

async function fetchHealth(url) {
  try {
    const response = await axios.get(`${url}/health`, { timeout: REQUEST_TIMEOUT_MS });
    return response.data;
  } catch {
    return null;
  }
}

async function discoverLeader() {
  let bestLeader = null;

  const checks = await Promise.all(
    Object.entries(REPLICAS).map(async ([id, url]) => {
      const health = await fetchHealth(url);
      return { id, url, health };
    })
  );

  for (const item of checks) {
    if (!item.health) {
      continue;
    }

    if (item.health.term > runtime.term) {
      runtime.term = item.health.term;
    }

    if (item.health.role === 'leader' && !item.health.shuttingDown) {
      if (!bestLeader || item.health.term >= bestLeader.term) {
        bestLeader = {
          id: item.id,
          url: item.url,
          term: item.health.term
        };
      }
    }
  }

  const changed =
    (!runtime.leader && bestLeader) ||
    (runtime.leader && !bestLeader) ||
    (runtime.leader && bestLeader && runtime.leader.id !== bestLeader.id);

  runtime.leader = bestLeader;

  if (changed) {
    logEvent('Leader update', { leader: runtime.leader });
    broadcast({
      type: 'LEADER_UPDATE',
      leader: runtime.leader
    });
  }

  return checks;
}

function broadcast(payload) {
  const text = JSON.stringify(payload);
  for (const client of runtime.clients) {
    if (client.readyState === 1) {
      client.send(text);
    }
  }
}

async function fetchLeaderState() {
  if (!runtime.leader) {
    return null;
  }

  try {
    const response = await axios.get(`${runtime.leader.url}/state`, { timeout: REQUEST_TIMEOUT_MS });
    return response.data;
  } catch {
    return null;
  }
}

async function pumpCommittedOperations() {
  const state = await fetchLeaderState();
  if (!state) {
    return;
  }

  const newOps = (state.operations || []).filter((op) => op.index > runtime.operationCursor);
  if (!newOps.length) {
    return;
  }

  for (const op of newOps) {
    runtime.operationCursor = Math.max(runtime.operationCursor, op.index);
    broadcast({
      type: 'DRAW_COMMITTED',
      operation: op
    });
  }
}

async function routeDrawCommand(payload, requestId) {
  if (!runtime.leader) {
    await discoverLeader();
  }
  if (!runtime.leader) {
    throw new Error('Leader unavailable');
  }

  try {
    logEvent('Routing draw command', {
      requestId,
      leaderId: runtime.leader.id,
      leaderTerm: runtime.leader.term
    });

    const response = await axios.post(
      `${runtime.leader.url}/command`,
      {
        type: 'DRAW',
        requestId,
        payload
      },
      {
        timeout: REQUEST_TIMEOUT_MS
      }
    );

    logEvent('Draw command accepted', {
      requestId,
      leaderId: runtime.leader.id
    });

    return response.data;
  } catch (error) {
    logEvent('Draw command routing failed', {
      requestId,
      leaderId: runtime.leader?.id || null
    });
    runtime.leader = null;
    throw error;
  }
}

app.post('/draw', async (req, res) => {
  const payload = req.body?.payload || req.body;
  const requestId = req.body?.requestId || generateRequestId();

  const validationError = validateDrawPayload(payload);
  if (validationError) {
    res.status(400).json({
      requestId,
      error: validationError
    });
    return;
  }

  try {
    const ack = await routeDrawCommand(payload, requestId);
    res.status(202).json({
      requestId,
      ack
    });
  } catch {
    res.status(503).json({
      requestId,
      error: 'Leader unavailable. Retry shortly.'
    });
  }
});

app.get('/health', async (req, res) => {
  await discoverLeader();
  res.json({
    service: 'gateway',
    leader: runtime.leader,
    term: runtime.term,
    connectedClients: runtime.clients.size,
    operationCursor: runtime.operationCursor
  });
});

app.get('/cluster', async (req, res) => {
  const replicas = await discoverLeader();
  res.json({
    leader: runtime.leader,
    replicas
  });
});

wss.on('connection', async (socket) => {
  runtime.clients.add(socket);

  socket.send(
    JSON.stringify({
      type: 'WELCOME',
      leader: runtime.leader,
      term: runtime.term
    })
  );

  const snapshot = await fetchLeaderState();
  if (snapshot) {
    socket.send(
      JSON.stringify({
        type: 'CANVAS_SNAPSHOT',
        operations: snapshot.operations || [],
        commitIndex: snapshot.commitIndex || 0,
        leader: runtime.leader
      })
    );
  }

  socket.on('message', async (raw) => {
    let payload;
    try {
      payload = JSON.parse(raw.toString());
    } catch {
      socket.send(JSON.stringify({ type: 'ERROR', message: 'Malformed JSON payload' }));
      return;
    }

    if (payload.type !== 'DRAW') {
      socket.send(
        JSON.stringify({
          type: 'ERROR',
          message: 'Unsupported message type'
        })
      );
      return;
    }

    const requestId = payload.requestId || generateRequestId();
    const validationError = validateDrawPayload(payload.payload);
    if (validationError) {
      socket.send(
        JSON.stringify({
          type: 'ERROR',
          requestId,
          message: validationError
        })
      );
      return;
    }

    try {
      const ack = await routeDrawCommand(payload.payload, requestId);
      socket.send(
        JSON.stringify({
          type: 'ACK',
          requestId,
          ack
        })
      );
    } catch {
      socket.send(
        JSON.stringify({
          type: 'ERROR',
          requestId,
          message: 'Failed to route draw command to current leader'
        })
      );
    }
  });

  socket.on('close', () => {
    runtime.clients.delete(socket);
  });
});

setInterval(() => {
  void discoverLeader();
}, LEADER_DISCOVERY_MS);

setInterval(() => {
  void pumpCommittedOperations();
}, POLL_INTERVAL_MS);

server.listen(PORT, () => {
  logEvent('Gateway runtime started', {
    port: PORT,
    replicas: Object.keys(REPLICAS)
  });
});
