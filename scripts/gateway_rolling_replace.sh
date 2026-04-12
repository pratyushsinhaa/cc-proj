#!/usr/bin/env bash
set -euo pipefail

SERVICE_NAME="${1:-gateway}"
HEALTH_URL="${2:-http://localhost:8080/health}"
CLUSTER_URL="${3:-http://localhost:8080/cluster}"

printf "[gateway-rolling-replace] Pre-check cluster visibility\n"
curl -fsS "$CLUSTER_URL" > /dev/null

printf "[gateway-rolling-replace] Build fresh image for %s\n" "$SERVICE_NAME"
docker compose build "$SERVICE_NAME"

printf "[gateway-rolling-replace] Replace %s container only\n" "$SERVICE_NAME"
docker compose up -d --no-deps --force-recreate "$SERVICE_NAME"

printf "[gateway-rolling-replace] Verifying post-replace health\n"
for attempt in $(seq 1 25); do
  if curl -fsS "$HEALTH_URL" > /dev/null; then
    printf "[gateway-rolling-replace] Replacement successful\n"
    exit 0
  fi
  sleep 1
done

printf "[gateway-rolling-replace] Post-replace health check failed\n" >&2
exit 1
