#!/usr/bin/env bash
set -euo pipefail

echo "Starting chaos demo: rapid replica failures and recoveries"

for i in {1..3}; do
  TARGET="replica$(( (RANDOM % 3) + 1 ))"
  echo "[Round $i] Killing $TARGET"
  docker compose kill "$TARGET"
  sleep 2
  echo "[Round $i] Restoring $TARGET"
  docker compose up -d "$TARGET"
  sleep 3

  echo "Gateway cluster view:"
  curl -s http://localhost:8080/cluster | cat
  echo
  sleep 2
done

echo "Chaos demo completed"
