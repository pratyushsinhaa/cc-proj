# MiniRAFT Collaborative Canvas

Distributed systems project implementing RAFT-lite leader election, log replication, failover handling, and a real-time multi-client drawing canvas.

## Team Members

1. Pratyush Sinha - PES2UG23CS441
2. Preetham Sanji - PES2UG23CS442
3. Prakhar Kumar - PES2UG23CS425
4. Rahul Anand - PES2UG23CS461

## Project Structure

- /gateway: WebSocket gateway, leader routing, runtime and dashboard endpoints
- /replica1: RAFT-lite replica service
- /replica2: RAFT-lite replica service
- /replica3: RAFT-lite replica service
- /raft_core: Python RAFT core module and HTTP endpoints
- /frontend: Browser drawing client/dashboard UI
- /docs: Architecture, demo script, and evidence docs
- /scripts: Reload, chaos, and log collection scripts
- docker-compose.yml: Local cluster orchestration

## Key Features

- Leader election with randomized timeouts and majority voting
- RAFT-style append and commit flow for drawing operations
- Gateway failover-aware routing with leader rediscovery retries
- WebSocket multi-client synchronization and snapshot catch-up
- Dashboard endpoint at /dashboard for cluster and consensus visibility
- Hot reload and rolling replacement scripts for runtime reliability

## RAFT Core

- Term and vote handling with log freshness checks
- RequestVote and AppendEntries RPC logic
- Candidate election loop and leader transition
- Leader replication tracking with nextIndex and matchIndex
- Majority commit advancement in the RAFT core state machine

Local verification for RAFT core:

```bash
python3 -m unittest discover -s tests -v
```

## Quick Start

Prerequisites:
- Docker and Docker Compose

Run:

```bash
docker compose up --build
```

Open:
- Frontend UI: http://localhost:3000
- Gateway health: http://localhost:8080/health
- Gateway cluster: http://localhost:8080/cluster
- Gateway dashboard: http://localhost:8080/dashboard

## Demo Commands

```bash
curl -s http://localhost:8080/cluster | cat
curl -s http://localhost:8080/dashboard | cat
bash scripts/hot_reload_replica.sh replica2
bash scripts/gateway_hot_reload.sh
bash scripts/gateway_rolling_replace.sh
bash scripts/chaos_demo.sh
bash scripts/collect_logs.sh
```

## Runtime Environment (Gateway)

- PORT
- REPLICA_URLS
- REQUEST_TIMEOUT_MS
- LEADER_DISCOVERY_MS
- POLL_INTERVAL_MS
- ROUTE_RETRY_ATTEMPTS
- EVENT_BUFFER_LIMIT

## Docs

- docs/architecture.md
- docs/demo-script.md
- docs/deployment-runbook.md
- docs/requirement-evidence-checklist.md

## Hosting Notes

The project can be demo-hosted on a single AWS free-tier EC2 instance with Docker Compose.
For a safer setup, expose only the frontend and gateway ports publicly and keep the replica ports private.
