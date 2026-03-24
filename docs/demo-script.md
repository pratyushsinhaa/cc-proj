# Demonstration Plan (8-10 minutes)

## 1. Startup and Baseline
1. Run docker compose up --build.
2. Open frontend in two or more browser tabs.
3. Draw strokes and show all tabs receiving updates.
4. Show /cluster output from gateway.

## 2. Leader Election Visibility
1. Query each replica /health endpoint.
2. Identify current leader and current term.
3. Show gateway /health leader view.

## 3. Leader Kill and Automatic Failover
1. Kill the leader container: docker compose kill replicaX.
2. Continue drawing during election window.
3. Show new leader elected with incremented term.
4. Show canvas remains consistent across tabs.

## 4. Hot Reload / Blue-Green Style Replacement
1. Edit one replica source line (for example log message text).
2. Run scripts/hot_reload_replica.sh replicaY.
3. Show cluster remains live while replica restarts.
4. Continue drawing and verify consistency.

## 5. Chaos Conditions
1. Run scripts/chaos_demo.sh.
2. Keep 2-3 client tabs connected and drawing.
3. Show no total outage as long as quorum survives.

## 6. Evidence Collection
1. Run scripts/collect_logs.sh.
2. Open saved log file from logs/.
3. Highlight election start, leader elected, and replication events.
