# Week 3 Failure Demo Script (Draft)

This draft focuses on gateway traceability and failure-case observability.

## Goal

Demonstrate that draw commands remain traceable and cluster behavior remains understandable during leader disruption.

## Prerequisites

- Services are running.
- At least two browser tabs are connected.
- Gateway endpoints available:
  - `GET /health`
  - `GET /cluster`
  - `GET /observability`

## Scenario 1: Baseline Traffic and Trace IDs

1. Open two tabs and draw in both.
2. Query gateway observability:

```bash
curl -s http://localhost:8080/observability
```

3. Confirm expected fields:
- `stats.drawCommandsReceived`
- `stats.drawCommandsRouted`
- `stats.drawCommandsAcked`
- `recentEvents` containing `draw.received` and `draw.acked`
- Matching `traceId` values for received and acked events.

## Scenario 2: Leader Kill During Active Drawing

1. Identify leader:

```bash
curl -s http://localhost:8080/cluster
```

2. Kill current leader container:

```bash
docker compose kill <leader-replica>
```

3. Continue drawing while failover occurs.
4. Query observability again:

```bash
curl -s http://localhost:8080/observability
```

5. Verify traceable failover evidence:
- `recentEvents` includes `draw.reroute_retry` or `draw.route_failed` during transition.
- `stats.rerouteRetries` increments if retry path was used.
- New `draw.acked` events appear after new leader stabilizes.

## Scenario 3: Malformed Client Payload Handling

1. Send malformed WebSocket payload (or simulate from browser console).
2. Confirm no process crash.
3. Verify in observability output:
- `stats.malformedMessages` increments.
- `recentEvents` includes `ws.malformed_payload`.

## Demo Talking Points

- Every draw operation has a trace id in gateway logs.
- Failover behavior is visible from structured event types.
- Routing retries are measurable with counters.
- Observability endpoint provides quick debugging signal during outages.

## Evidence to Capture

- Terminal output snippets of `GET /observability` before and after leader kill.
- One screenshot of cluster leader change.
- One screenshot of continued canvas activity after failover.
