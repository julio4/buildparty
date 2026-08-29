#!/bin/sh
set -eu

image="buildparty:production-smoke"
container="buildparty-production-smoke-$$"
cleanup() { docker rm -f "$container" >/dev/null 2>&1 || true; }
trap cleanup EXIT INT TERM

docker build -t "$image" .
docker run -d --name "$container" -p 127.0.0.1::3001 \
  --entrypoint node "$image" --import tsx src/server.ts >/dev/null
port=$(docker port "$container" 3001/tcp | awk -F: 'NR == 1 { print $NF }')
for _ in $(seq 1 30); do
  if curl -fsS "http://127.0.0.1:$port/api/health" >/dev/null 2>&1; then break; fi
  sleep 1
done
curl -fsS "http://127.0.0.1:$port/" | grep -q '<div id="root"></div>'
curl -fsS "http://127.0.0.1:$port/party/smoke" | grep -q '<div id="root"></div>'
test "$(curl -sS -o /dev/null -w '%{http_code}' "http://127.0.0.1:$port/api/not-real")" = 404
! curl -fsS "http://127.0.0.1:$port/" | grep -q 'buildparty-local-electric-secret-change-me'
echo "Production image serves the SPA and keeps unknown API paths out of static fallback."
