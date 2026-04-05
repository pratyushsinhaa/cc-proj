# MiniRAFT Collaborative Canvas

Cloud Computing project for Sem 6 (2026).

## Team Members

1. Pratyush Sinha - PES2UG23CS441
2. Preetham Sanji - PES2UG23CS442
3. Prakhar Kumar - PES2UG23CS425
4. Rahul Anand - PES2UG23CS461

## Branch Purpose

This branch contains Preetham's gateway/runtime portion of the project.
The target is to provide the request ingress and leader-aware routing layer that plugs into replica services and frontend clients during integration.

## Implemented in This Branch

- Gateway runtime service under gateway/
- Leader discovery from configured replicas
- WebSocket ingest path for draw operations
- Leader-routed draw command forwarding
- Committed operation polling and broadcast fanout
- Health and cluster observability endpoints
- Containerization files for gateway service

## Gateway Quick Start

1. Go to gateway/.
2. Install dependencies with npm install.
3. Start with npm start.

Example environment configuration:

- PORT=8080
- REPLICA_URLS={"replica1":"http://localhost:5001","replica2":"http://localhost:5002","replica3":"http://localhost:5003"}
- REQUEST_TIMEOUT_MS=1000
- LEADER_DISCOVERY_MS=1500
- POLL_INTERVAL_MS=500

## Documentation

- docs/gateway-runtime.md
