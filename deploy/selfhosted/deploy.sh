#!/usr/bin/env bash
# Self-hosted ERP deploy: build image, start compose, wait for health.
# Prerequisite: Supabase (or compatible API) reachable at SUPABASE_URL in .env — see README.md.
# Reverse proxy (TLS, domain) is manual — point it at http://127.0.0.1:3000 after this succeeds.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

ENV_FILE="${DEPLOY_ENV_FILE:-.env}"
if [[ ! -f "$ENV_FILE" ]]; then
  echo "Missing ${ENV_FILE}. Copy .env.example to .env and fill secrets." >&2
  exit 1
fi

if ! command -v docker >/dev/null 2>&1; then
  echo "docker is required" >&2
  exit 1
fi

SKIP_BUILD=false
for arg in "$@"; do
  case "$arg" in
    --no-build) SKIP_BUILD=true ;;
    -h | --help)
      echo "Usage: $0 [--no-build]"
      echo "  --no-build   Skip docker compose build (faster restarts after image exists)"
      echo "  DEPLOY_ENV_FILE   Path to env file (default: .env in this directory)"
      exit 0
      ;;
  esac
done

COMPOSE=(docker compose --env-file "$ENV_FILE")

if [[ "$SKIP_BUILD" != true ]]; then
  echo "==> Building ERP image..."
  "${COMPOSE[@]}" build erp
fi

echo "==> Starting postgres + erp..."
"${COMPOSE[@]}" up -d

echo "==> Waiting for http://127.0.0.1:3000/health ..."
ok=false
for _ in $(seq 1 45); do
  if curl -fsS -o /dev/null "http://127.0.0.1:3000/health" 2>/dev/null; then
    ok=true
    break
  fi
  sleep 2
done

if [[ "$ok" != true ]]; then
  echo "WARN: /health did not return success in time." >&2
  echo "Check: docker compose --env-file ${ENV_FILE} logs erp" >&2
  exit 1
fi

echo "==> Health check OK."
echo ""
echo "ERP listens on 0.0.0.0:3000 — point your reverse proxy at http://127.0.0.1:3000"
echo "Set X-Forwarded-Proto / X-Forwarded-Host as in README.md."
