# Deployment Runbook

## Local Docker Compose

1. Install Docker Desktop or the Docker engine.
2. Run `docker compose up --build -d` from the repository root.
3. Verify the following endpoints:
   - `http://localhost:3000`
   - `http://localhost:8080/health`
   - `http://localhost:8080/cluster`
   - `http://localhost:8080/dashboard`
   - `http://localhost:8080/observability`

## AWS Free-Tier Single-Host Deployment

This project can be hosted on one free-tier EC2 instance for demo purposes.

Recommended setup:
1. Launch Ubuntu Server on EC2 free tier.
2. Install Docker and Docker Compose.
3. Clone the repository.
4. Run `docker compose up --build -d`.
5. Open security-group ports:
   - `3000` for the frontend
   - `8080` for the gateway
   - `5001-5003` only if you want direct replica inspection

Safer alternative:
1. Expose only `3000` and `8080` publicly.
2. Keep replica ports private to the instance.
3. Use an Nginx or ALB reverse proxy if you want HTTPS later.

## Recovery Commands

1. Restart a single replica: `docker compose up -d replica1`
2. Restart the whole stack: `docker compose down && docker compose up --build -d`
3. Capture logs: `bash scripts/collect_logs.sh`
