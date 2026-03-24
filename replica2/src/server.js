import express from 'express';
import cors from 'cors';
import axios from 'axios';

const app = express();
app.use(cors());
app.use(express.json({ limit: '2mb' }));

const NODE_ID = process.env.NODE_ID || 'replica1';
const PORT = Number(process.env.PORT || 5001);
const PEERS = JSON.parse(process.env.PEERS || '{}');
const ELECTION_TIMEOUT_MIN_MS = Number(process.env.ELECTION_TIMEOUT_MIN_MS || 1500);
const ELECTION_TIMEOUT_MAX_MS = Number(process.env.ELECTION_TIMEOUT_MAX_MS || 3000);
const HEARTBEAT_INTERVAL_MS = Number(process.env.HEARTBEAT_INTERVAL_MS || 600);
const REQUEST_TIMEOUT_MS = Number(process.env.REQUEST_TIMEOUT_MS || 800);

const state = {
  currentTerm: 0,
  role: 'follower',
  votedFor: null,
  leaderId: null,
  log: [],
  commitIndex: 0,
  lastApplied: 0,
  stateMachine: {
    operations: []
  },
  election: {
    timeoutHandle: null,
    heartbeatHandle: null,
    shuttingDown: false
  },
  replication: {
    nextIndex: {},
    matchIndex: {}
  }
};

function now() {
  return new Date().toISOString();
}

function logEvent(message, data = {}) {
  const entry = {
    ts: now(),
    node: NODE_ID,
    term: state.currentTerm,
    role: state.role,
    message,
    ...data
  };
  console.log(JSON.stringify(entry));
}

function randomElectionTimeout() {
  return Math.floor(
    Math.random() * (ELECTION_TIMEOUT_MAX_MS - ELECTION_TIMEOUT_MIN_MS + 1) + ELECTION_TIMEOUT_MIN_MS
  );
}

function lastLogIndex() {
  return state.log.length;
}

function lastLogTerm() {
  if (!state.log.length) {
    return 0;
  }
  return state.log[state.log.length - 1].term;
}

function applyCommittedEntries() {
  while (state.lastApplied < state.commitIndex) {
    state.lastApplied += 1;
    const entry = state.log[state.lastApplied - 1];
    if (!entry) {
      continue;
    }
    if (entry.command?.type === 'DRAW') {
      state.stateMachine.operations.push({
        index: entry.index,
        term: entry.term,
        payload: entry.command.payload,
        appliedAt: now()
      });
    }
  }
}

function stopHeartbeat() {
  if (state.election.heartbeatHandle) {
    clearInterval(state.election.heartbeatHandle);
    state.election.heartbeatHandle = null;
  }
}

function resetElectionTimer() {
  if (state.election.shuttingDown) {
    return;
  }
  if (state.election.timeoutHandle) {
    clearTimeout(state.election.timeoutHandle);
  }
  state.election.timeoutHandle = setTimeout(() => {
    void startElection();
  }, randomElectionTimeout());
}

function becomeFollower(term, leaderId = null) {
  if (term > state.currentTerm) {
    state.currentTerm = term;
    state.votedFor = null;
  }
  state.role = 'follower';
  state.leaderId = leaderId;
  stopHeartbeat();
  resetElectionTimer();
}

function majorityCount() {
  const totalNodes = Object.keys(PEERS).length + 1;
  return Math.floor(totalNodes / 2) + 1;
}

async function requestVoteFromPeer(peerId, peerUrl, payload) {
  try {
    const response = await axios.post(`${peerUrl}/raft/request-vote`, payload, {
      timeout: REQUEST_TIMEOUT_MS
    });
    return response.data;
  } catch {
    return null;
  }
}

async function appendEntriesToPeer(peerId, peerUrl, payload) {
  try {
    const response = await axios.post(`${peerUrl}/raft/append-entries`, payload, {
      timeout: REQUEST_TIMEOUT_MS
    });
    return response.data;
  } catch {
    return null;
  }
}

function initializeLeaderReplicationState() {
  for (const peerId of Object.keys(PEERS)) {
    state.replication.nextIndex[peerId] = lastLogIndex() + 1;
    state.replication.matchIndex[peerId] = 0;
  }
}

async function startElection() {
  if (state.election.shuttingDown) {
    return;
  }
  state.role = 'candidate';
  state.currentTerm += 1;
  state.votedFor = NODE_ID;
  state.leaderId = null;
  const termAtStart = state.currentTerm;
  let votesGranted = 1;

  resetElectionTimer();
  logEvent('Election started', { term: termAtStart });

  const votePayload = {
    term: termAtStart,
    candidateId: NODE_ID,
    lastLogIndex: lastLogIndex(),
    lastLogTerm: lastLogTerm()
  };

  const voteRequests = Object.entries(PEERS).map(async ([peerId, peerUrl]) => {
    const result = await requestVoteFromPeer(peerId, peerUrl, votePayload);
    return { peerId, result };
  });

  const outcomes = await Promise.all(voteRequests);

  for (const { peerId, result } of outcomes) {
    if (!result) {
      continue;
    }
    if (result.term > state.currentTerm) {
      logEvent('Election aborted due to higher term', { from: peerId, newTerm: result.term });
      becomeFollower(result.term, null);
      return;
    }
    if (
      state.role === 'candidate' &&
      state.currentTerm === termAtStart &&
      result.voteGranted
    ) {
      votesGranted += 1;
    }
  }

  if (state.role !== 'candidate' || state.currentTerm !== termAtStart) {
    return;
  }

  if (votesGranted >= majorityCount()) {
    state.role = 'leader';
    state.leaderId = NODE_ID;
    initializeLeaderReplicationState();
    stopHeartbeat();
    state.election.heartbeatHandle = setInterval(() => {
      void sendHeartbeats();
    }, HEARTBEAT_INTERVAL_MS);
    logEvent('Leader elected', { votesGranted, majority: majorityCount() });
    await sendHeartbeats();
  } else {
    logEvent('Election lost', { votesGranted, majority: majorityCount() });
    becomeFollower(state.currentTerm, null);
  }
}

async function sendHeartbeats() {
  if (state.role !== 'leader' || state.election.shuttingDown) {
    return;
  }

  const tasks = Object.entries(PEERS).map(async ([peerId, peerUrl]) => {
    const nextIdx = state.replication.nextIndex[peerId] ?? (lastLogIndex() + 1);
    const prevLogIndex = Math.max(0, nextIdx - 1);
    const prevLogTerm = prevLogIndex === 0 ? 0 : state.log[prevLogIndex - 1]?.term ?? 0;
    const entries = state.log.slice(nextIdx - 1);

    const payload = {
      term: state.currentTerm,
      leaderId: NODE_ID,
      prevLogIndex,
      prevLogTerm,
      entries,
      leaderCommit: state.commitIndex
    };

    const result = await appendEntriesToPeer(peerId, peerUrl, payload);
    if (!result) {
      return;
    }

    if (result.term > state.currentTerm) {
      logEvent('Stepping down: discovered higher term', { from: peerId, newTerm: result.term });
      becomeFollower(result.term, null);
      return;
    }

    if (result.success) {
      state.replication.matchIndex[peerId] = result.matchIndex;
      state.replication.nextIndex[peerId] = result.matchIndex + 1;
    } else {
      const currentNext = state.replication.nextIndex[peerId] ?? 1;
      state.replication.nextIndex[peerId] = Math.max(1, currentNext - 1);
    }
  });

  await Promise.all(tasks);
  advanceCommitIndex();
}

function advanceCommitIndex() {
  if (state.role !== 'leader') {
    return;
  }

  const matchIndexes = Object.values(state.replication.matchIndex);
  matchIndexes.push(lastLogIndex());
  matchIndexes.sort((a, b) => b - a);

  const quorumIndex = matchIndexes[majorityCount() - 1] ?? 0;
  if (quorumIndex > state.commitIndex) {
    const candidateEntry = state.log[quorumIndex - 1];
    if (candidateEntry?.term === state.currentTerm) {
      state.commitIndex = quorumIndex;
      applyCommittedEntries();
    }
  }
}

app.get('/health', (req, res) => {
  res.json({
    nodeId: NODE_ID,
    role: state.role,
    term: state.currentTerm,
    leaderId: state.leaderId,
    commitIndex: state.commitIndex,
    logLength: state.log.length,
    shuttingDown: state.election.shuttingDown
  });
});

app.get('/state', (req, res) => {
  res.json({
    nodeId: NODE_ID,
    role: state.role,
    term: state.currentTerm,
    leaderId: state.leaderId,
    commitIndex: state.commitIndex,
    logLength: state.log.length,
    operations: state.stateMachine.operations
  });
});

app.post('/raft/request-vote', (req, res) => {
  const { term, candidateId, lastLogIndex: candidateLastLogIndex, lastLogTerm: candidateLastLogTerm } = req.body;

  if (term < state.currentTerm) {
    return res.json({ term: state.currentTerm, voteGranted: false });
  }

  if (term > state.currentTerm) {
    becomeFollower(term, null);
  }

  const myLastTerm = lastLogTerm();
  const myLastIndex = lastLogIndex();

  const candidateLogIsUpToDate =
    candidateLastLogTerm > myLastTerm ||
    (candidateLastLogTerm === myLastTerm && candidateLastLogIndex >= myLastIndex);

  const canVote =
    (state.votedFor === null || state.votedFor === candidateId) &&
    candidateLogIsUpToDate &&
    !state.election.shuttingDown;

  if (canVote) {
    state.votedFor = candidateId;
    resetElectionTimer();
    logEvent('Vote granted', { candidateId, term: state.currentTerm });
    return res.json({ term: state.currentTerm, voteGranted: true });
  }

  return res.json({ term: state.currentTerm, voteGranted: false });
});

app.post('/raft/append-entries', (req, res) => {
  const { term, leaderId, prevLogIndex, prevLogTerm, entries, leaderCommit } = req.body;

  if (term < state.currentTerm) {
    return res.json({ term: state.currentTerm, success: false, matchIndex: lastLogIndex() });
  }

  if (term > state.currentTerm || state.role !== 'follower') {
    becomeFollower(term, leaderId);
  } else {
    state.leaderId = leaderId;
    resetElectionTimer();
  }

  if (prevLogIndex > 0) {
    const localPrev = state.log[prevLogIndex - 1];
    if (!localPrev || localPrev.term !== prevLogTerm) {
      return res.json({ term: state.currentTerm, success: false, matchIndex: lastLogIndex() });
    }
  }

  let insertionIndex = prevLogIndex;
  for (const entry of entries || []) {
    insertionIndex += 1;
    const localEntry = state.log[insertionIndex - 1];
    if (localEntry && localEntry.term !== entry.term) {
      state.log = state.log.slice(0, insertionIndex - 1);
    }
    if (!state.log[insertionIndex - 1]) {
      state.log.push(entry);
    }
  }

  if (leaderCommit > state.commitIndex) {
    state.commitIndex = Math.min(leaderCommit, lastLogIndex());
    applyCommittedEntries();
  }

  return res.json({ term: state.currentTerm, success: true, matchIndex: lastLogIndex() });
});

app.post('/command', async (req, res) => {
  if (state.role !== 'leader') {
    return res.status(409).json({
      error: 'Not leader',
      leaderId: state.leaderId
    });
  }

  if (state.election.shuttingDown) {
    return res.status(503).json({ error: 'Node is shutting down' });
  }

  const command = req.body;
  const newEntry = {
    index: lastLogIndex() + 1,
    term: state.currentTerm,
    command,
    createdAt: now()
  };

  state.log.push(newEntry);
  logEvent('Command appended', { index: newEntry.index, type: command?.type });

  await sendHeartbeats();

  if (state.commitIndex >= newEntry.index) {
    return res.status(201).json({
      accepted: true,
      index: newEntry.index,
      term: newEntry.term
    });
  }

  state.log.pop();
  return res.status(503).json({
    accepted: false,
    reason: 'Failed to replicate to majority'
  });
});

app.post('/admin/graceful-reload', (req, res) => {
  logEvent('Graceful reload requested via API');
  triggerGracefulShutdown();
  res.json({ ok: true, nodeId: NODE_ID });
});

const server = app.listen(PORT, () => {
  logEvent('Replica started', {
    port: PORT,
    peers: Object.keys(PEERS)
  });
  resetElectionTimer();
});

function triggerGracefulShutdown() {
  if (state.election.shuttingDown) {
    return;
  }
  state.election.shuttingDown = true;
  stopHeartbeat();
  if (state.election.timeoutHandle) {
    clearTimeout(state.election.timeoutHandle);
    state.election.timeoutHandle = null;
  }
  state.role = 'follower';
  logEvent('Node entering graceful shutdown');

  setTimeout(() => {
    server.close(() => {
      logEvent('HTTP server closed gracefully');
      process.exit(0);
    });
  }, 250);

  setTimeout(() => {
    process.exit(0);
  }, 4000);
}

process.on('SIGTERM', triggerGracefulShutdown);
process.on('SIGINT', triggerGracefulShutdown);
