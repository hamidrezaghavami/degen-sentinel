#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

if [ ! -f .env ]; then
  cp .env.example .env
  echo "Created .env from .env.example — fill in your API keys and re-run ./run.sh"
  exit 1
fi

if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
  if [ "${1:-}" = "--once" ]; then
    exec docker compose run --rm degen-sentinel node index.js --once
  elif [ "${1:-}" = "--bg" ]; then
    exec docker compose up -d --build
  else
    exec docker compose up --build
  fi
fi

if command -v pnpm >/dev/null 2>&1; then
  [ -d node_modules ] || pnpm install --frozen-lockfile
  exec pnpm start -- "$@"
fi

[ -d node_modules ] || npm ci --omit=dev
exec node index.js "$@"
