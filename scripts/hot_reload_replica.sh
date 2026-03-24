#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "Usage: $0 <replica1|replica2|replica3>"
  exit 1
fi

TARGET="$1"

case "$TARGET" in
  replica1) ADMIN_PORT=5001 ;;
  replica2) ADMIN_PORT=5002 ;;
  replica3) ADMIN_PORT=5003 ;;
esac

if [[ "$TARGET" != "replica1" && "$TARGET" != "replica2" && "$TARGET" != "replica3" ]]; then
  echo "Invalid replica: $TARGET"
  exit 1
fi

echo "Triggering graceful reload on $TARGET"
curl -s -X POST "http://localhost:${ADMIN_PORT}/admin/graceful-reload" >/dev/null || true

echo "Rebuilding and replacing $TARGET with zero app downtime"
docker compose build "$TARGET"
docker compose up -d --no-deps "$TARGET"

echo "$TARGET replaced. Cluster should remain live with quorum."
