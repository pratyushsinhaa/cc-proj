# MiniRAFT Collaborative Canvas

Distributed systems project implementing RAFT-lite leader election, log replication, failover, and a real-time multi-client drawing canvas.

## Team Members

1. Pratyush Sinha - PES2UG23CS441
2. Preetham Sanji - PES2UG23CS442
3. Prakhar Kumar - PES2UG23CS425
4. Rahul Anand - PES2UG23CS461

## Project Structure

- /gateway: WebSocket gateway and cluster router
- /replica1: RAFT-lite replica service
- /replica2: RAFT-lite replica service
- /replica3: RAFT-lite replica service
- /frontend: Browser canvas client
- /docs: Architecture and demo runbook
- /scripts: Reliability and testing scripts
- docker-compose.yml: Local cluster orchestration

## Features Implemented

### Week 2 Scope

- Leader election with randomized timeouts and majority votes
- WebSocket gateway for client event ingress
- Basic RAFT-style log replication
- Drawing canvas integration

### Week 3 Scope

- Graceful reload for replicas via signal handling
- Blue-green style single-replica replacement without cluster shutdown
- Failover correctness through term checks and majority commit
- Multi-client real-time synchronization
- Chaos demo script for rapid failure conditions

## Quick Start

Prerequisites:
- Docker + Docker Compose

Run the cluster:

```bash
docker compose up --build
```

Open the app:
- Frontend UI: http://localhost:3000
- Gateway health: http://localhost:8080/health
- Cluster view: http://localhost:8080/cluster
- Replica health: http://localhost:5001/health, http://localhost:5002/health, http://localhost:5003/health

## Demonstrating Required Behaviors

### 1) Drawing from multiple users

- Open two or more browser tabs at http://localhost:3000
- Draw simultaneously and observe synchronized updates

### 2) Kill the leader and show failover

1. Identify leader:

```bash
curl -s http://localhost:8080/cluster | cat
```

2. Kill leader container:

```bash
docker compose kill replica1
```

3. Wait a few seconds and verify a new leader appears.

### 3) Hot-reload any replica with uptime preserved

```bash
bash scripts/hot_reload_replica.sh replica2
```

### 4) Chaos conditions demo

```bash
bash scripts/chaos_demo.sh
```

### 5) Capture failover logs

```bash
bash scripts/collect_logs.sh
```

Generated logs will appear under /logs.

## Protocol Summary

- Election RPC: POST /raft/request-vote
- Replication RPC: POST /raft/append-entries
- Leader command append: POST /command
- Replica state query: GET /state
- Health query: GET /health

Commit rule:
- Leader marks a log index committed only after majority replication in current term.

## Docs

- Detailed architecture: docs/architecture.md
- Video/demo checklist: docs/demo-script.md

## Notes

- This repository intentionally targets local containerized deployment.
- Cloud VM deployment is excluded for now and can be added later.
