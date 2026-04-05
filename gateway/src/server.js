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
const REPLICAS = JSON.parse(process.env.REPLICA_URLS || '{}');
const REQUEST_TIMEOUT_MS = Number(process.env.REQUEST_TIMEOUT_MS || 1000);
const LEADER_DISCOVERY_MS = Number(process.env.LEADER_DISCOVERY_MS || 1500);

const runtime = {
  leader: null,
  term: 0,
  clients: new Set()
};

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
  }

  return checks;
}

async function routeDrawCommand(payload) {
  if (!runtime.leader) {
    await discoverLeader();
  }
  if (!runtime.leader) {
    throw new Error('Leader unavailable');
  }

  try {
    const response = await axios.post(
      `${runtime.leader.url}/command`,
      {
        type: 'DRAW',
        payload
      },
      {
        timeout: REQUEST_TIMEOUT_MS
      }
    );
    return response.data;
  } catch (error) {
    runtime.leader = null;
    throw error;
  }
}

app.get('/health', async (req, res) => {
  await discoverLeader();
  res.json({
    service: 'gateway',
    leader: runtime.leader,
    term: runtime.term
  });
});

app.get('/cluster', async (req, res) => {
  const replicas = await discoverLeader();
  res.json({
    leader: runtime.leader,
    replicas
  });
});

wss.on('connection', (socket) => {
  runtime.clients.add(socket);

  socket.send(
    JSON.stringify({
      type: 'WELCOME',
      leader: runtime.leader,
      term: runtime.term
    })
  );

  socket.on('message', async (raw) => {
    let payload;
    try {
      payload = JSON.parse(raw.toString());
    } catch {
      socket.send(JSON.stringify({ type: 'ERROR', message: 'Malformed JSON payload' }));
      return;
    }

    if (payload.type !== 'DRAW') {
      return;
    }

    try {
      const ack = await routeDrawCommand(payload.payload);
      socket.send(JSON.stringify({ type: 'ACK', ack }));
    } catch {
      socket.send(
        JSON.stringify({
          type: 'ERROR',
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

server.listen(PORT, () => {
  logEvent('Gateway runtime started', {
    port: PORT,
    replicas: Object.keys(REPLICAS)
  });
});
