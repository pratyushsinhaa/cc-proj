import http from 'node:http';
import express from 'express';
import cors from 'cors';
import axios from 'axios';
import { WebSocketServer } from 'ws';

const app = express();
app.use(cors());
app.use(express.json({ limit: '2mb' }));

const PORT = Number(process.env.PORT || 8080);
const REPLICAS = JSON.parse(process.env.REPLICA_URLS || '{}');
const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS || 500);
const LEADER_DISCOVERY_MS = Number(process.env.LEADER_DISCOVERY_MS || 1000);
const REQUEST_TIMEOUT_MS = Number(process.env.REQUEST_TIMEOUT_MS || 900);

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const runtime = {
  leader: null,
  term: 0,
  operationCursor: 0,
  clients: new Set(),
  nextClientId: 1,
  nextTraceId: 1,
  stats: {
    wsConnectionsTotal: 0,
    wsMessagesTotal: 0,
    drawCommandsReceived: 0,
    drawCommandsRouted: 0,
    drawCommandsAcked: 0,
    rerouteRetries: 0,
    routeFailures: 0,
    committedBroadcasts: 0,
    malformedMessages: 0
  },
  recentEvents: []
};

function logEvent(message, data = {}) {
  const entry = {
    ts: new Date().toISOString(),
    service: 'gateway',
    message,
    ...data
  };
  runtime.recentEvents.push(entry);
  if (runtime.recentEvents.length > 120) {
    runtime.recentEvents.shift();
  }
  console.log(JSON.stringify(entry));
}

function leaderFromId(leaderId) {
  if (!leaderId || !REPLICAS[leaderId]) {
    return null;
  }
  return {
    id: leaderId,
    url: REPLICAS[leaderId],
    term: runtime.term
  };
}

function newTraceId() {
  const id = runtime.nextTraceId;
  runtime.nextTraceId += 1;
  return `draw-${id}`;
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

  const checks = Object.entries(REPLICAS).map(async ([id, url]) => {
    const health = await fetchHealth(url);
    return { id, url, health };
  });

  const results = await Promise.all(checks);

  for (const result of results) {
    if (!result.health) {
      continue;
    }
    if (result.health.term > runtime.term) {
      runtime.term = result.health.term;
    }
    if (result.health.role === 'leader' && !result.health.shuttingDown) {
      if (!bestLeader || result.health.term >= bestLeader.term) {
        bestLeader = {
          id: result.id,
          url: result.url,
          term: result.health.term
        };
      }
    }
  }

  if (bestLeader && (!runtime.leader || runtime.leader.id !== bestLeader.id || runtime.leader.term !== bestLeader.term)) {
    runtime.leader = bestLeader;
    logEvent('Leader discovered', runtime.leader);
    broadcast({ type: 'LEADER_UPDATE', leader: runtime.leader });
  }

  if (!bestLeader) {
    runtime.leader = null;
  }
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
    runtime.stats.committedBroadcasts += 1;
    broadcast({
      type: 'DRAW_COMMITTED',
      operation: op
    });
  }
}

async function routeDrawCommand(commandPayload, options = {}) {
  const allowRetry = options.allowRetry ?? true;
  const traceId = options.traceId || newTraceId();
  const clientId = options.clientId || null;

  if (!runtime.leader) {
    await discoverLeader();
  }
  if (!runtime.leader) {
    runtime.stats.routeFailures += 1;
    logEvent('Command route failed: leader unavailable', { traceId, clientId });
    throw new Error('Leader unavailable');
  }

  try {
    const response = await axios.post(
      `${runtime.leader.url}/command`,
      {
        type: 'DRAW',
        payload: commandPayload,
        meta: {
          traceId,
          clientId,
          gatewayReceivedAt: new Date().toISOString()
        }
      },
      {
        timeout: REQUEST_TIMEOUT_MS
      }
    );
    runtime.stats.drawCommandsRouted += 1;
    return {
      ...response.data,
      traceId
    };
  } catch (error) {
    const hintedLeader = leaderFromId(error?.response?.data?.leaderId);
    if (allowRetry && hintedLeader) {
      runtime.leader = hintedLeader;
      runtime.stats.rerouteRetries += 1;
      logEvent('Retrying command using leader hint', {
        traceId,
        clientId,
        hintedLeader: hintedLeader.id
      });
      return routeDrawCommand(commandPayload, { allowRetry: false, traceId, clientId });
    }

    runtime.leader = null;
    if (allowRetry) {
      await discoverLeader();
      if (runtime.leader) {
        runtime.stats.rerouteRetries += 1;
        logEvent('Retrying command after leader rediscovery', {
          traceId,
          clientId,
          leader: runtime.leader.id
        });
        return routeDrawCommand(commandPayload, { allowRetry: false, traceId, clientId });
      }
    }

    runtime.stats.routeFailures += 1;
    logEvent('Command route failed', {
      traceId,
      clientId,
      error: error?.message || 'unknown error'
    });
    throw error;
  }
}

app.get('/health', async (req, res) => {
  await discoverLeader();
  res.json({
    service: 'gateway',
    leader: runtime.leader,
    connectedClients: runtime.clients.size,
    operationCursor: runtime.operationCursor,
    term: runtime.term,
    stats: runtime.stats
  });
});

app.get('/observability', async (req, res) => {
  await discoverLeader();
  res.json({
    service: 'gateway',
    leader: runtime.leader,
    term: runtime.term,
    connectedClients: runtime.clients.size,
    operationCursor: runtime.operationCursor,
    stats: runtime.stats,
    recentEvents: runtime.recentEvents
  });
});

app.get('/cluster', async (req, res) => {
  await discoverLeader();
  const checks = await Promise.all(
    Object.entries(REPLICAS).map(async ([id, url]) => {
      const health = await fetchHealth(url);
      return {
        id,
        url,
        health
      };
    })
  );

  res.json({
    leader: runtime.leader,
    replicas: checks
  });
});

wss.on('connection', async (socket) => {
  const clientId = `c${runtime.nextClientId++}`;
  socket.clientId = clientId;
  runtime.clients.add(socket);
  runtime.stats.wsConnectionsTotal += 1;
  logEvent('Client connected', {
    clientId,
    connectedClients: runtime.clients.size
  });

  if (!runtime.leader) {
    await discoverLeader();
  }

  socket.send(
    JSON.stringify({
      type: 'WELCOME',
      clientId,
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
    runtime.stats.wsMessagesTotal += 1;
    let payload;
    try {
      payload = JSON.parse(raw.toString());
    } catch {
      runtime.stats.malformedMessages += 1;
      socket.send(JSON.stringify({ type: 'ERROR', message: 'Malformed JSON payload' }));
      return;
    }

    if (payload.type === 'DRAW') {
      runtime.stats.drawCommandsReceived += 1;
      const traceId = newTraceId();
      logEvent('Draw command received', {
        traceId,
        clientId,
        hasPayload: Boolean(payload.payload)
      });
      try {
        const ack = await routeDrawCommand(payload.payload, { traceId, clientId });
        runtime.stats.drawCommandsAcked += 1;
        logEvent('Draw command replicated', {
          traceId,
          clientId,
          ack
        });
        socket.send(JSON.stringify({ type: 'ACK', ack }));
      } catch (error) {
        logEvent('Draw command replication failed', {
          traceId,
          clientId,
          error: error?.message || 'unknown error'
        });
        socket.send(
          JSON.stringify({
            type: 'ERROR',
            message: 'Failed to replicate draw command. Retry shortly.'
          })
        );
      }
    }
  });

  socket.on('close', () => {
    runtime.clients.delete(socket);
    logEvent('Client disconnected', {
      clientId,
      connectedClients: runtime.clients.size
    });
  });
});

setInterval(() => {
  void discoverLeader();
}, LEADER_DISCOVERY_MS);

setInterval(() => {
  void pumpCommittedOperations();
}, POLL_INTERVAL_MS);

server.listen(PORT, () => {
  logEvent('Gateway started', {
    port: PORT,
    replicas: Object.keys(REPLICAS)
  });
});
