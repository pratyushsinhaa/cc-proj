#!/usr/bin/env bash
set -euo pipefail

mkdir -p logs

timestamp=$(date +%Y%m%d-%H%M%S)
docker compose logs gateway replica1 replica2 replica3 > "logs/failover-${timestamp}.log"

echo "Saved logs/failover-${timestamp}.log"
