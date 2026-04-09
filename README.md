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

## Week-Wise Preetham Completion

### Week 1: Design and Architecture

- Gateway service ownership finalized: client ingress, leader discovery, leader-only routing, and committed-event fanout.
- Replica integration contract finalized for `/health`, `/state`, and `/command`.
- Leader rerouting and failover behavior finalized:
	- detect route failure
	- invalidate cached leader
	- rediscover leader
	- retry command route
- Observability baseline finalized with gateway health and cluster visibility endpoints.

### Week 2: Core Implementation

- WebSocket gateway ingress implemented for DRAW messages.
- Leader discovery and forwarding implemented for command routing to active replica leader.
- HTTP ingress endpoint added at `/draw` for integration and scripted validation.
- Input validation and request ID tracing added for draw command flow.

### Week 3: Reliability and Testing

- Failover-aware route retry behavior added with configurable retry attempts.
- Catch-up realignment added to recover client view after leader changes.
- Structured event buffering added through `/runtime` for traceable runtime events.
- Graceful shutdown handling added for restart-safe gateway lifecycle.
- Gateway reliability workflows added:
	- `scripts/gateway_hot_reload.sh`
	- `scripts/gateway_rolling_replace.sh`

### Week 4: Final Polish and Demo Readiness

- Dashboard-ready aggregation endpoint added at `/dashboard` with:
	- leader, term, role and health per replica
	- committed stroke count and recent consensus events
	- gateway connection count and failover status
- Operator runbook steps consolidated in README for deployment and recovery.
- Runtime environment reference table added for integration readiness.

## Implemented in This Branch

- Gateway runtime service under gateway/
- Leader discovery from configured replicas
- WebSocket ingest path for draw operations
- Leader-routed draw command forwarding
- Committed operation polling and broadcast fanout
- Health, cluster, runtime, and dashboard observability endpoints
- Containerization files for gateway service
- Gateway hot-reload and rolling-replacement scripts

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

Additional gateway runtime variables:

- ROUTE_RETRY_ATTEMPTS=2
- EVENT_BUFFER_LIMIT=120

## Week 4 Operator Runbook (Preetham Scope)

1. Start or refresh the gateway container: `docker compose up -d --build gateway`
2. Verify gateway health: `curl -fsS http://localhost:8080/health`
3. Verify cluster snapshot visibility: `curl -fsS http://localhost:8080/cluster`
4. Verify dashboard data for demo: `curl -fsS http://localhost:8080/dashboard`
5. For hot reload replacement: `bash scripts/gateway_hot_reload.sh`
6. For rolling replacement: `bash scripts/gateway_rolling_replace.sh`

## Runtime Environment Table (Integration Reference)

| Service | Variable | Purpose |
|---|---|---|
| gateway | PORT | Gateway listen port |
| gateway | REPLICA_URLS | Replica id to URL mapping consumed by gateway |
| gateway | REQUEST_TIMEOUT_MS | Timeout for replica API calls |
| gateway | LEADER_DISCOVERY_MS | Leader discovery polling interval |
| gateway | POLL_INTERVAL_MS | Committed operation polling interval |
| gateway | ROUTE_RETRY_ATTEMPTS | Retry count during leader reroute |
| gateway | EVENT_BUFFER_LIMIT | In-memory runtime event buffer size |
| replica services | /health, /state, /command endpoints | Runtime contract consumed by gateway |
| frontend clients | WebSocket messages DRAW, ACK, ERROR, LEADER_UPDATE, DRAW_COMMITTED, CANVAS_SNAPSHOT | Gateway-client runtime contract |
