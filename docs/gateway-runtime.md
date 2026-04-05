# Gateway Runtime Ownership Notes (Preetham)

This document defines the scope implemented on the preetham branch for gateway/runtime ownership.

## Responsibilities

- Discover active RAFT leader from replica health APIs.
- Accept client drawing events on WebSocket.
- Route draw commands to current leader.
- Poll committed operations and fan out to all connected clients.
- Provide cluster and gateway health introspection endpoints.

## Runtime API

- GET /health
  - Returns gateway term view, current leader, connected clients and operation cursor.
- GET /cluster
  - Returns latest health information from all configured replicas.
- WebSocket /
  - Receives DRAW messages from clients.
  - Emits WELCOME, ACK, ERROR, LEADER_UPDATE, CANVAS_SNAPSHOT and DRAW_COMMITTED events.

## Environment Variables

- PORT
  - Gateway listen port. Default: 8080.
- REPLICA_URLS
  - JSON object mapping replica id to base URL.
  - Example: {"replica1":"http://replica1:5001","replica2":"http://replica2:5002","replica3":"http://replica3:5003"}
- REQUEST_TIMEOUT_MS
  - Per-request timeout when calling replicas. Default: 1000.
- LEADER_DISCOVERY_MS
  - Poll interval for leader discovery. Default: 1500.
- POLL_INTERVAL_MS
  - Poll interval for committed operation sync. Default: 500.

## Integration Notes

- The gateway assumes replicas expose /health, /state and /command.
- Leader changes are broadcast to all clients through LEADER_UPDATE.
- Client snapshot on connect improves convergence after reconnects.
