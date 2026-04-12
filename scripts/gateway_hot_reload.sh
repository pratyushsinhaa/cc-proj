#!/usr/bin/env bash
set -euo pipefail

SERVICE_NAME="${1:-gateway}"
HEALTH_URL="${2:-http://localhost:8080/health}"

printf "[gateway-hot-reload] Rebuilding %s\n" "$SERVICE_NAME"
docker compose build "$SERVICE_NAME"

printf "[gateway-hot-reload] Recreating %s without restarting dependencies\n" "$SERVICE_NAME"
docker compose up -d --no-deps "$SERVICE_NAME"

printf "[gateway-hot-reload] Waiting for health: %s\n" "$HEALTH_URL"
for attempt in $(seq 1 25); do
  if curl -fsS "$HEALTH_URL" > /dev/null; then
    printf "[gateway-hot-reload] Gateway healthy after %s attempt(s)\n" "$attempt"
    exit 0
  fi
  sleep 1
done

printf "[gateway-hot-reload] Gateway did not recover in expected time\n" >&2
exit 1
