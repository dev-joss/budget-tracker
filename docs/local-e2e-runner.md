# Local backend e2e runner

Run tests from `packages/backend/` through the existing npm script:

```sh
npm run test:e2e -- --testPathPattern='user/set-password\.e2e\.ts$'
```

Local runs retain PostgreSQL, Redis, and a verified migrated template. A hash of the checkout's canonical path scopes the Compose project. Checkouts with the same folder name have separate test services and volumes.

Each invocation builds the runner image so source edits and deleted files reach the tests. It starts a fresh one-off runner container, recreates the worker databases from the template, and clears the dedicated test Redis service. Node and the application start fresh. A named volume retains the Jest cache for this checkout. T2 validation and timing results are recorded in the performance plan.

## Jest cache

The local Compose override mounts `test_jest_cache` at `/var/cache/bt-local-e2e/jest` and sets `LOCAL_E2E_CACHE_ROOT`. The E2E config uses a subdirectory keyed by Node version, platform, architecture, the dependency lockfile and package manifests, TypeScript configs, Jest configs, the custom ESM transformer, and the cache-key helper. CI uses the default cache path because its runner does not set this variable.

Jest retains its source-content and configuration invalidation within each directory. Source edits keep the directory stable; dependency or transform-input changes select a different directory. This also covers the custom ESM transformer's dependency on TypeScript. Required key inputs must exist or config loading fails. If a new transform helper or inherited TypeScript config is added, include it in the key inputs.

The cache does not depend on database seed dates. Older cache directories remain available until the explicit reset removes the volume. `--no-cache` can disable Jest cache use for a comparison; it does not remove the volume. The runner still rebuilds current source on each invocation.

## Template validity

The template key includes:

- All migration files, including nested migration helpers.
- Exchange-rate and merchant-category seed files.
- The dependency lockfile and root, backend, and shared package manifests.
- Root and backend TypeScript configuration.
- The local runner, migration runner, and key helper.
- Node version, processor architecture, PostgreSQL version, test environment, UTC timezone, and UTC calendar day.

The exchange-rate migration seeds rates ten days before the current date. The local runner uses UTC and rebuilds the template when the UTC date changes. It checks migration names, schema definitions, seed contents, and seed dates before it publishes the validity marker. Reuse requires the key and verification signature to match. A missing or invalid marker, an incomplete setup, or a failed verification causes a rebuild on the next invocation. A failed test returns a failure status.

## Reset and concurrency

To stop this checkout's test containers and remove its test volumes, including all Jest cache directories:

```sh
npm run test:e2e -- --reset
```

Reset intentionally stops active tests in this checkout. It retains images and Docker build cache. Other checkout projects and development services are outside this reset. Reset before the first run after a PostgreSQL major-version change; an existing database volume is not compatible with a different major version.

Do not run overlapping e2e commands or change test-service configuration during an active run. A database advisory lock guards template preparation, worker resets, and test execution. Compose starts the services before this lock is acquired, so the lock cannot protect an active run from a service configuration change or an explicit reset.

## Scope

This implements the local service/template lifecycle in T1 and the cache design in T2 of [the performance plan](local-e2e-performance-plan.md). No prior architecture decision record for the test runner was found. The application architecture and CI runner behavior remain unchanged. This document describes the design; correctness checks and measured performance belong in the plan's work log.

## Test-file cleanup

The e2e Jest environment closes each file's queue workers and other test resources at `run_finish`, before Jest tears down its modules. This also runs when all tests in a file are skipped. A skipped file must not leave queue consumers alive for the next file in the same worker. Cleanup errors fail the run. This does not reuse the application between files.
