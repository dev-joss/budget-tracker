# Local backend e2e runner

Run tests from `packages/backend/` through the existing npm script:

```sh
npm run test:e2e -- --testPathPattern='user/set-password\.e2e\.ts$'
```

Local runs retain PostgreSQL, Redis, and a verified migrated template. A hash of the checkout's canonical path scopes the Compose project. Checkouts with the same folder name have separate test services and volumes.

Each invocation builds the runner image so source edits and deleted files reach the tests. It starts a fresh one-off runner container, recreates the worker databases from the template, and clears the dedicated test Redis service. Node, the application, and the Jest transform cache start fresh. Transform-cache persistence remains T2 work.

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

To stop this checkout's test containers and remove its test volumes:

```sh
npm run test:e2e -- --reset
```

Reset intentionally stops active tests in this checkout. It retains images and Docker build cache. Other checkout projects and development services are outside this reset. Reset before the first run after a PostgreSQL major-version change; an existing database volume is not compatible with a different major version.

Do not run overlapping e2e commands or change test-service configuration during an active run. A database advisory lock guards template preparation, worker resets, and test execution. Compose starts the services before this lock is acquired, so the lock cannot protect an active run from a service configuration change or an explicit reset.

## Scope

This implements the local service and template lifecycle authorized by T1 in [the performance plan](local-e2e-performance-plan.md). No prior architecture decision record for the test runner was found. The application architecture and CI runner behavior remain unchanged. This document describes the design; correctness checks and measured performance belong in the plan's work log.

## Test-file cleanup

The e2e Jest environment closes each file's queue workers and other test resources at `run_finish`, before Jest tears down its modules. This also runs when all tests in a file are skipped. A skipped file must not leave queue consumers alive for the next file in the same worker. Cleanup errors fail the run. This does not reuse the application between files.
