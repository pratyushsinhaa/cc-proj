# Requirement-to-Evidence Checklist

This checklist maps assignment requirements to concrete endpoints, files, and demo evidence.

## 1. Leader election stable across restarts and failovers

- Evidence in code:
  - Replica election and term handling via `/raft/request-vote` and `/raft/append-entries`.
- Runtime verification:
  - `GET /cluster` shows one active leader and replica states.
  - Kill leader and verify term/leader changes.
- Capture:
  - Terminal output before and after leader kill.

## 2. Majority commit preserved during failures

- Evidence in code:
  - Leader command append path commits only after quorum.
- Runtime verification:
  - Draw while one replica is down and confirm commits continue.
- Capture:
  - `GET /observability` counters and trace events.

## 3. Multi-client drawing consistent after leader changes

- Evidence in flow:
  - Gateway forwards draw commands to current leader and broadcasts committed operations.
- Runtime verification:
  - Two or more tabs draw before/during/after leader failover.
- Capture:
  - Screenshots from multiple tabs and failover window.

## 4. One-replica rolling replacement without full outage

- Evidence in operations:
  - Graceful reload and one-replica replacement workflow.
- Runtime verification:
  - Replace one replica and continue drawing.
- Capture:
  - Command output and continuity screenshots.

## 5. Hot-reload workflow exists and is documented

- Evidence in docs:
  - Demo script includes failover and observability workflow.
- Runtime verification:
  - Restart/replace one service while clients stay connected.
- Capture:
  - Logs and endpoint snapshots.

## 6. Dashboard shows live cluster and consensus status

- Evidence in API:
  - `GET /dashboard` includes:
    - leader, term, replica role/health
    - committed stroke count and recent consensus events
    - gateway connection and reroute/failover status
- Runtime verification:
  - Poll `GET /dashboard` during normal traffic and failover.
- Capture:
  - JSON snapshots before and after leader change.

## 7. Requirement-to-evidence mapping is complete

- Evidence in docs:
  - This file plus architecture and demo script.

## 8. Demo script reproduces full behavior in one pass

- Evidence in docs:
  - [docs/demo-script.md](docs/demo-script.md) final sequence.
- Runtime verification:
  - Execute script top to bottom without manual re-ordering.
- Capture:
  - One continuous run recording with key checkpoints.
