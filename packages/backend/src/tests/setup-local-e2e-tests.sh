#!/bin/bash
set -euo pipefail

# A canonical path hash keeps checkouts with the same basename isolated.
CHECKOUT_ROOT=$(cd ../.. && pwd -P)
WORKTREE_KEY=$(node -e 'process.stdout.write(require("node:crypto").createHash("sha256").update(process.argv[1]).digest("hex").slice(0, 12))' "$CHECKOUT_ROOT")
export COMPOSE_PROJECT_NAME="bt-local-e2e-${WORKTREE_KEY}"
export TEST_RUNNER_IMAGE="${COMPOSE_PROJECT_NAME}-test-runner"
echo "Using COMPOSE_PROJECT_NAME=${COMPOSE_PROJECT_NAME}"

compose() {
  docker compose -f ../../docker/test/backend/docker-compose.yml \
    -f ../../docker/test/backend/docker-compose.local.yml "$@"
}

if [ "${1:-}" = "--reset" ]; then
  if [ "$#" -ne 1 ]; then
    echo "ERROR: --reset must be used without test arguments"
    exit 1
  fi
  compose down --volumes --remove-orphans
  echo "Local e2e services and template removed for this checkout."
  exit 0
fi

# Build on every invocation so edited and deleted source files reach the runner.
compose build test-runner
compose up -d test-db test-redis

wait_for() {
  for _ in $(seq 1 120); do
    if "$@" >/dev/null 2>&1; then return 0; fi
    sleep 0.5
  done
  echo "ERROR: timed out waiting for test services. If the PostgreSQL major version changed, run npm run test:e2e -- --reset first."
  return 1
}

echo "Waiting for test services..."
wait_for compose exec -T test-db pg_isready -h 127.0.0.1 -U "$APPLICATION_DB_USERNAME" -d "$APPLICATION_DB_DATABASE"
wait_for compose exec -T test-redis redis-cli ping

# One-off runners have no reusable app process or transform cache. PostgreSQL
# and Redis stay available; the runner exits with the migration or Jest status.
compose run --rm -T --no-deps \
  -e SHOW_LOGS_IN_TESTS="${SHOW_LOGS_IN_TESTS:-}" test-runner \
  node -r ts-node/register/transpile-only packages/backend/src/tests/run-local-e2e.ts "$@"
