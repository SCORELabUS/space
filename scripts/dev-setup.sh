#!/usr/bin/env bash
set -euo pipefail

if ! nc -z 127.0.0.1 27017 2>/dev/null || ! nc -z 127.0.0.1 6378 2>/dev/null; then
  docker compose -f docker/local/docker-compose.yml up -d mongodb redis
fi

echo "Waiting for shared MongoDB and Redis..."
for i in {1..30}; do
  if nc -z 127.0.0.1 27017 2>/dev/null && nc -z 127.0.0.1 6378 2>/dev/null; then
    break
  fi
  sleep 1
done

if ! nc -z 127.0.0.1 27017 2>/dev/null || ! nc -z 127.0.0.1 6378 2>/dev/null; then
  echo "MongoDB/Redis are not reachable on localhost (27017/6378)." >&2
  exit 1
fi

echo "Shared local dependencies are ready. SPACE uses database space_db and Redis prefix space:."

(cd api && SEED_RESET_DATABASE=true npx tsx scripts/seedMongodb.ts)
