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
const ROUTE_RETRY_ATTEMPTS = Number(process.env.ROUTE_RETRY_ATTEMPTS || 2);
const EVENT_BUFFER_LIMIT = Number(process.env.EVENT_BUFFER_LIMIT || 120);

const runtime = {
  leader: null,
  term: 0,
  clients: new Set(),
  operationCursor: 0,
  routeAttempts: 0,
  routeFailures: 0,
  leaderChanges: 0,
  shuttingDown: false,
  recentEvents: [],
  stats: {
    drawCommandsReceived: 0,
    drawCommandsAcked: 0,
    malformedMessages: 0,
    rerouteRetries: 0
  }
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

function recordEvent(type, data = {}) {
  runtime.recentEvents.push({
    ts: new Date().toISOString(),
    type,
    ...data
  });

  if (runtime.recentEvents.length > EVENT_BUFFER_LIMIT) {
    runtime.recentEvents.splice(0, runtime.recentEvents.length - EVENT_BUFFER_LIMIT);
  }
}

function validateDrawPayload(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return 'DRAW payload must be a JSON object';
  }
  return null;
}

function logEvent(message, data = {}) {
  recordEvent(message, data);
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

async function collectReplicaSnapshot() {
  return Promise.all(
    Object.entries(REPLICAS).map(async ([id, url]) => {
      const health = await fetchHealth(url);
      return {
        id,
        url,
        healthy: Boolean(health),
        role: health?.role || 'unknown',
        term: health?.term ?? null,
        commitIndex: health?.commitIndex ?? null,
        leaderId: health?.leaderId ?? null,
        shuttingDown: Boolean(health?.shuttingDown)
      };
    })
  );
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
    (runtime.leader && bestLeader && runtime.leader.id !== bestLeader.id) ||
    (runtime.leader && bestLeader && runtime.leader.term !== bestLeader.term);

  runtime.leader = bestLeader;

  if (changed) {
    runtime.leaderChanges += 1;
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

  const stateOps = state.operations || [];
  const highestStateIndex = stateOps.length ? stateOps[stateOps.length - 1].index : 0;
  if (highestStateIndex < runtime.operationCursor) {
    runtime.operationCursor = highestStateIndex;
    broadcast({
      type: 'CANVAS_SNAPSHOT',
      operations: stateOps,
      commitIndex: state.commitIndex || highestStateIndex,
      leader: runtime.leader
    });
    logEvent('Operation cursor realigned from leader snapshot', {
      highestStateIndex
    });
  }

  const newOps = stateOps.filter((op) => op.index > runtime.operationCursor);
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
  const maxAttempts = Math.max(1, ROUTE_RETRY_ATTEMPTS);
  let lastError = new Error('Leader unavailable');

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    runtime.routeAttempts += 1;

    if (!runtime.leader) {
      await discoverLeader();
    }
    if (!runtime.leader) {
      continue;
    }

    if (attempt > 1) {
      runtime.stats.rerouteRetries += 1;
      logEvent('Draw reroute retry', { requestId, attempt });
    }

    try {
      logEvent('Routing draw command', {
        requestId,
        attempt,
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
        attempt,
        leaderId: runtime.leader.id
      });

      return response.data;
    } catch (error) {
      runtime.routeFailures += 1;
      lastError = error;
      logEvent('Draw command routing failed', {
        requestId,
        attempt,
        leaderId: runtime.leader?.id || null
      });
      runtime.leader = null;
      await discoverLeader();
    }
  }

  throw lastError;
}

app.post('/draw', async (req, res) => {
  const payload = req.body?.payload || req.body;
  const requestId = req.body?.requestId || generateRequestId();

  runtime.stats.drawCommandsReceived += 1;

  const validationError = validateDrawPayload(payload);
  if (validationError) {
    runtime.stats.malformedMessages += 1;
    res.status(400).json({
      requestId,
      error: validationError
    });
    return;
  }

  try {
    const ack = await routeDrawCommand(payload, requestId);
    runtime.stats.drawCommandsAcked += 1;
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
    operationCursor: runtime.operationCursor,
    routeAttempts: runtime.routeAttempts,
    routeFailures: runtime.routeFailures,
    leaderChanges: runtime.leaderChanges,
    shuttingDown: runtime.shuttingDown
  });
});

app.get('/cluster', async (req, res) => {
  await discoverLeader();
  const replicas = await collectReplicaSnapshot();
  res.json({
    leader: runtime.leader,
    replicas
  });
});

app.get('/dashboard', async (req, res) => {
  await discoverLeader();
  const replicas = await collectReplicaSnapshot();
  const maxReplicaTerm = replicas.reduce((max, item) => {
    if (typeof item.term !== 'number') {
      return max;
    }
    return Math.max(max, item.term);
  }, 0);

  const recentConsensusEvents = runtime.recentEvents
    .filter((event) => {
      return (
        event.type === 'Leader update' ||
        event.type === 'Draw command accepted' ||
        event.type === 'Operation cursor realigned from leader snapshot'
      );
    })
    .slice(-12);

  res.json({
    cluster: {
      leader: runtime.leader,
      term: Math.max(runtime.term, maxReplicaTerm),
      replicas
    },
    consensus: {
      committedStrokeCount: runtime.operationCursor,
      recentEvents: recentConsensusEvents
    },
    gateway: {
      connectedClients: runtime.clients.size,
      routeAttempts: runtime.routeAttempts,
      routeFailures: runtime.routeFailures,
      leaderChanges: runtime.leaderChanges,
      drawCommandsReceived: runtime.stats.drawCommandsReceived,
      drawCommandsAcked: runtime.stats.drawCommandsAcked,
      malformedMessages: runtime.stats.malformedMessages,
      rerouteRetries: runtime.stats.rerouteRetries,
      failoverStatus: runtime.routeFailures > 0 ? 'recovering' : 'stable'
    }
  });
});

app.get('/observability', (req, res) => {
  res.json({
    leader: runtime.leader,
    term: runtime.term,
    stats: {
      drawCommandsReceived: runtime.stats.drawCommandsReceived,
      drawCommandsRouted: runtime.routeAttempts,
      drawCommandsAcked: runtime.stats.drawCommandsAcked,
      rerouteRetries: runtime.stats.rerouteRetries,
      malformedMessages: runtime.stats.malformedMessages,
      routeFailures: runtime.routeFailures,
      connectedClients: runtime.clients.size,
      operationCursor: runtime.operationCursor
    },
    recentEvents: runtime.recentEvents.slice(-25)
  });
});

app.get('/runtime', (req, res) => {
  res.json({
    leader: runtime.leader,
    term: runtime.term,
    operationCursor: runtime.operationCursor,
    connectedClients: runtime.clients.size,
    routeAttempts: runtime.routeAttempts,
    routeFailures: runtime.routeFailures,
    leaderChanges: runtime.leaderChanges,
    drawCommandsReceived: runtime.stats.drawCommandsReceived,
    drawCommandsAcked: runtime.stats.drawCommandsAcked,
    malformedMessages: runtime.stats.malformedMessages,
    rerouteRetries: runtime.stats.rerouteRetries,
    shuttingDown: runtime.shuttingDown,
    recentEvents: runtime.recentEvents.slice(-25)
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
      runtime.stats.malformedMessages += 1;
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
      runtime.stats.malformedMessages += 1;
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
      runtime.stats.drawCommandsReceived += 1;
      const ack = await routeDrawCommand(payload.payload, requestId);
      runtime.stats.drawCommandsAcked += 1;
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

const leaderDiscoveryTimer = setInterval(() => {
  void discoverLeader();
}, LEADER_DISCOVERY_MS);

const committedPumpTimer = setInterval(() => {
  void pumpCommittedOperations();
}, POLL_INTERVAL_MS);

function shutdownGracefully(signal) {
  if (runtime.shuttingDown) {
    return;
  }

  runtime.shuttingDown = true;
  logEvent('Gateway shutdown initiated', { signal });

  clearInterval(leaderDiscoveryTimer);
  clearInterval(committedPumpTimer);

  for (const client of runtime.clients) {
    try {
      client.close(1001, 'Gateway restarting');
    } catch {
      // Best effort close.
    }
  }

  server.close(() => {
    logEvent('Gateway shutdown complete', { signal });
    process.exit(0);
  });

  setTimeout(() => {
    process.exit(1);
  }, 5000).unref();
}

process.on('SIGINT', () => shutdownGracefully('SIGINT'));
process.on('SIGTERM', () => shutdownGracefully('SIGTERM'));

server.listen(PORT, () => {
  logEvent('Gateway runtime started', {
    port: PORT,
    replicas: Object.keys(REPLICAS)
  });
});
