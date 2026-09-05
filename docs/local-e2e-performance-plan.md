# Local backend e2e performance plan

Status: T0 baseline complete; T1–T8 remain pending.
Evidence date: 2026-09-04.

## Objective and scope

Reduce the time from a backend edit to useful local test results. Target the current laptop and Colima allocation: 6 CPUs and 8 GB RAM. Keep HTTP endpoint coverage, test isolation, and correct transaction behavior.

The user requested investigation, a ranked set of options, and this plan for future agents. Docker and the current runner design can be reconsidered. Work on one bounded task below at a time. Do not commit unless the user later requests it. Follow the repository rules for dependencies and architecture decisions. Keep CI changes outside this local performance task unless they are separately requested.

All source paths below are relative to the current repository root. Read the current repository instructions and `.claude/docs/backend-conventions.md` before implementation. Preserve unrelated changes. At handoff, the checkout already contained untracked `packages/backend/node-profiles/` and `packages/backend/packages/`; neither directory is disposable task output.

## Evidence to retain

The main capture directory is:

`packages/backend/node-profiles/container-batch-20260904-234240/`

Read these files before repeating analysis:

- `reviewed-options.md`: analysis, ranked options, and limits.
- `readme.md` and `profile-summary.json`: capture method and environment.
- `jest-batch-startup-through-exit.cpuprofile`: complete Node/Jest CPU profile.
- `jest-results.json`, `selected-tests.json`, and `capture.log`: cases, selection, results, and elapsed times.

The valid single-file capture is in `packages/backend/node-profiles/container-capture-20260904-233606/`. Older host-wrapper and partial inspector profiles are not valid evidence for application startup cost. The temporary capture harness was under `/tmp`; future work must not depend on it still existing.

The profiles are untracked. A different checkout may not contain them. Preserve them in this checkout, and confirm their availability before requesting another capture. This document includes the baseline and test selection so the work can continue without the original conversation.

| Measurement | Result |
| --- | ---: |
| Selected batch | 14 files; 218 tests passed |
| Complete profiled command | 99.271 s |
| Jest reported duration | 45.561 s |
| Template migration phase | About 38.4 s |
| Container cleanup | About 11 s |
| Worker database cloning and verification | Less than 1 s |
| Test cases, including beforeEach/afterEach | 27.819 s |
| Time inside test files but outside cases | 17.659 s |
| Module loading/evaluation, excluding transforms | About 10.041 s of sampled stacks |
| Transform toolchain and descendants | About 5.202 s of sampled stacks |
| Async hooks/context machinery | About 5.428 s of self samples |
| Garbage collection | About 3.191 s of samples |
| Highest reported heap between files | 1,830 MB |

The initial setup import took about 6.346 s. The next 13 setup imports took another 8.018 s. Faker import stacks accounted for about 2.009 s. About 4.706 s of transformation occurred in the first 14 s of the capture.

Do not add overlapping measurements. These are affected areas, not promised savings. Case time includes hooks. Idle samples are not equivalent to database time. Faker import time is not demo-generation execution time.

The capture used Node 23.11.0, Jest 29.7.0, ARM64, and one serial Jest process with `workerIdleMemoryLimit` removed. It does not measure normal four-worker execution or restart frequency. Heap samples are not RSS or retained heap after full GC. No retention root or accumulated hook count was proved. `--forceExit` was enabled. Profiling overhead was not isolated with a matching unprofiled batch. The recorded source revision was `1aa114beaa5ce131ad6e9342a370f52af11eb77d`; establish a new baseline if the checkout differs.

## Execution rules and measurement method

- Run e2e tests through npm scripts from `packages/backend/`. Do not invoke `npx jest` directly. Do not run separate e2e commands concurrently, including from other agents. Combine files in one selection. Keep the existing worker configuration for baseline runs.
- Do not change Colima resources during a comparison. Record Node/dependency versions, source revision and diff, image identity, selected files, worker count, recycling threshold, cache state, and whether profiling is enabled.
- Separate total command time into build/start, template preparation, database cloning, Jest, and cleanup. Record test and suite counts, failures, retries, skips, and exit status. Confirm the selection is nonempty; the existing runner permits no-test results.
- Use unprofiled runs for speed comparisons. Start with one trial to screen a change. For a candidate to retain, collect at least three comparable warm trials for baseline and candidate; report median and range. Alternate variants when practical. Repeat only when changes or variance justify it.
- Record a first-use run with fresh task-owned test services/template/cache. Also measure the routine warm rerun and a controlled source-edit rerun. State exactly which caches and images are warm. Do not remove unrelated containers, images, volumes, or files to create a cold run.
- Use the small suite and fixed batch below for comparisons. Check the selected files against the saved manifest. The historical counts are 3 tests and 218 tests; record any source changes that alter them.
- Profile only when a specific question needs it. Capture the actual Jest execution process inside the container from startup through exit, including workers when used. Verify backend source frames and case execution. A host npm profile or a coordinator-only profile is insufficient.
- A diagnostic npm script may launch Node with its startup CPU profiler. Copy profiles out before container cleanup. `--runInBand` alone did not ensure one process while the memory-recycling setting was present; verify process behavior rather than assuming it.
- Use diagnostic runs for hook/query timings, resource counts, and memory analysis. Keep that instrumentation out of the unprofiled timing comparison. A CPU profile of Jest cannot measure PostgreSQL or Redis CPU work.
- Follow the repository stop rule: after one or two unsuccessful attempts at an unexpected failure, report the evidence and ask for direction. Do not continue through speculative workarounds.

Small suite:

```sh
npm run test:e2e -- --testPathPattern='user/set-password\.e2e\.ts$'
```

Fixed batch, in one invocation:

```sh
npm run test:e2e -- --testPathPattern='src/services/(user/(set-password|update-user)|categories/categories|budgets/budget-crud|transactions/get-by-id|transactions/splits/splits|subscriptions/subscriptions|payees/payees|currencies/add-user-currency|stats/get-net-worth-history|investments/transactions/create|bank-data-providers/sync/sync-status-tracker|import-export/csv-import/execute-import|accounts/archive-account)\.e2e\.ts$'
```

Run focused existing checks after each relevant change. Use `npm run typecheck` and `npm run lint` for changed backend TypeScript, and `npm run test:unit -- --testPathPattern='<pattern>'` when unit behavior changes. Run the full `npm run test:e2e` after an accepted change to shared setup or execution behavior; repeat broader checks only for new changes, failures, or unresolved concerns. New regression tests must protect a concrete failure or boundary. E2e assertions must exercise HTTP helpers, not service calls.

## Task order and dependencies

Impact ranking and implementation order differ. Persistent cache work comes early because it is small. Application reuse has larger scope and needs a lifecycle design first.

| ID | Task | Depends on | Initial status |
| --- | --- | --- | --- |
| T0 | Establish comparable local baseline | Existing evidence | Complete |
| T1 | Persist local services and migrated template | T0 | Pending |
| T2 | Persist Jest transform cache | T0; integrate with T1 | Pending |
| T3 | Reduce eager imports; audit contexts and resource lifetime | T0 | Pending |
| T4 | Reuse application initialization across files | T3 | Pending |
| T5 | Reduce measured fixture/reset costs | T0; benchmark current retained design | Pending |
| T6 | Tune workers and memory recycling | Retained T1–T5 changes | Pending |
| T7 | Compare native Node with container Node | Stable retained baseline | Optional experiment |
| T8 | Evaluate compiler, native databases, or runner replacement | Remaining measured bottleneck | Deferred |

### T0 — Establish the baseline

Read the capture and inspect `packages/backend/src/tests/setup-e2e-tests.sh`, `docker/test/backend/docker-compose.yml`, `docker/test/backend/Dockerfile`, both backend Jest configs, and `packages/backend/src/tests/setupIntegrationTests.ts`.

Measure the small suite and fixed batch using the normal npm entry point, without CPU profiling. Record phase times and the actual process/worker configuration. Check memory and worker restart evidence separately if needed. The existing setup sources `.env.test`, so verify effective settings inside the runner rather than assuming host environment overrides survive.

Deliver a compact results table with exact commands and environment details. Accept T0 when another agent can repeat it and distinguish measured wall time from the serial diagnostic profile. Do not rerun the full original investigation by default.

### T1 — Persist services and the migrated template

Main files: `packages/backend/src/tests/setup-e2e-tests.sh`, `packages/backend/src/tests/run-template-migrations.ts`, and `docker/test/backend/`. Inspect the existing CI template cache in `.github/workflows/check-source-code.yml` as a precedent; do not change CI behavior for this task.

Implement local reuse of PostgreSQL/Redis and a verified migrated template. Recreate isolated worker databases from that template for each invocation. Retain useful local runner/cache state only with a reliable source refresh path. Keep worktree scoping and provide an explicit way to reset only this test environment.

Define a template validity key from migration content and other inputs that affect schema or seeds. Include runtime/database compatibility where required. The exchange-rate migration `packages/backend/src/migrations/1664386509637-exchange-rates.js` uses the current date; define and test its refresh rule. Publish cache validity only after migration and verification succeed. Detect incomplete or invalid cached state and rebuild it.

Acceptance:

- An unchanged warm run skips the full migration cycle and automatic teardown of reusable services. Record the actual savings against the roughly 50-second opportunity.
- Cold setup, migration/seed changes, date-dependent refresh, explicit reset, and recovery after an interrupted setup work correctly.
- A failed test still returns failure. Test data and Redis/queue state do not survive into the next invocation in a way that changes results.
- A backend source edit reaches the next test run. No stale image or app process produces a false pass.
- Other worktrees and development services remain untouched. Validate the fixed batch, then the full suite for this shared setup change.

### T2 — Persist the transform cache

Main files: `packages/backend/jest.config.base.ts`, `packages/backend/jest.config.e2e.ts`, and the local runner/volume setup.

Keep Jest's cache across local invocations with a stable path. Preserve Jest's content/config invalidation. Ensure dependency or transformer changes cannot reuse incompatible output, and include cache removal in the explicit local reset path. Do not introduce a compiler replacement in this task.

Acceptance: measure cold and warm small/batch runs; prove a source edit and a transform-config change take effect; verify the cache is actually reused. Keep only a repeatable benefit beyond timing noise. Report savings separately from T1.

### T3 — Reduce eager imports and audit lifetime

Start with `packages/backend/src/tests/setupIntegrationTests.ts`, `packages/backend/src/app.ts`, the background-job initialization path, `packages/backend/src/crons/demo-template-refresh.ts`, demo-template services, `packages/backend/src/tests/helpers/index.ts`, and `packages/backend/src/tests/mocks/setup-mock-server.ts`.

Make one import change at a time. The test-mode guard stops background jobs from starting, but static imports still load their dependencies. The demo/Faker import chain is a measured candidate. Ensure any deferred loading preserves normal application and job behavior. Reprofile only enough to confirm the targeted import cost changed.

Audit `packages/backend/src/models/connection.ts`, `packages/backend/src/common/lib/cls/{logging,session-id}.ts`, `packages/backend/src/common/request-context.ts`, and `packages/backend/src/services/common/with-transaction.ts`. The installed cls-hooked implementation enables hooks without retaining a handle for disable. This is evidence to investigate, not proof of a leak.

Check namespace creation, request context isolation, database/auth pools, process listeners, queue workers, Redis connections, and awaited server shutdown across files. Establish retention or resource-count evidence before assigning the heap growth to a cause. Consider the existing native AsyncLocalStorage approach for logging/session context. Preserve Sequelize transaction propagation and rollback behavior.

Acceptance: pass relevant HTTP success/error/rollback tests; show the measured import, context, or resource improvement; confirm background-job behavior remains correct. If a leak fix is claimed, provide before/after retention evidence. Do not count garbage-collection time or the full 5.4 seconds of hook samples as automatically recoverable.

### T4 — Reuse application initialization

Before code changes, document how the application, database, Redis keys, queues, mocks, and test fixtures will be owned and reset. Evaluate one app lifetime per worker. Resolve how per-file MSW handlers and other mocks reach the application, how state is reset, and how worker replacement closes resources.

Moving imports to Jest globalSetup alone does not establish shared application lifetime. An external app process also changes where mocks must run. Choose the smallest design that removes repeated initialization while preserving those contracts. Read related specifications and follow repository decision-record rules for an architecture change.

Acceptance:

- Instrumentation demonstrates the intended number of app starts and shutdowns.
- Files pass alone, in the fixed batch, and in a changed file order without state contamination.
- Workers retain isolated databases and request contexts; queue work and mock overrides do not cross test boundaries.
- Record startup, total time, memory, and cleanup results. Verify natural shutdown in a separate diagnostic run before claiming lifecycle closure; `--forceExit` cannot prove it.
- Run the full suite before accepting a shared lifecycle change.

### T5 — Reduce per-test reset and fixture work

Time the existing global hooks and their database/Redis operations. Break out readiness checks, table discovery/truncation, user/account/session creation, reference-data seeding, login, and currency setup. The 27.8-second case total is an upper area to investigate, not a fixture-cost measurement.

Optimize the largest measured repeat. Candidates include avoiding repeated discovery of an unchanged table list, retaining immutable reference data, or using a verified baseline for common fixtures. Prove isolation and freshness before reusing state. Do not replace HTTP behavior with direct service calls or wrap HTTP tests in a transaction that their real connections do not share.

Acceptance: show before/after hook/query totals and unprofiled run times; preserve isolated users, dates, exchange rates, currencies, Redis state, and queue state. Run affected feature tests and the fixed batch; use the full suite for changes to global hooks.

### T6 — Tune workers and recycling

Measure the retained design under the existing four-worker setting, then compare lower worker counts in separate invocations. Keep database counts and effective runner settings consistent. Record total time, per-worker RSS/heap, restart events, VM memory pressure, database connections, failures, and timeouts.

Do not infer restart counts from the serial profile. Do not disable recycling or raise all worker limits based only on the 1.8 GB diagnostic heap value. The objective is stable fast feedback within 6 CPUs and 8 GB, not maximum CPU occupancy.

Acceptance: select the fastest repeatable configuration that fits the current VM and passes the full suite without OOM, retries hiding failures, or new timeout behavior. Preserve CI settings unless separately requested.

### T7 — Compare Node on macOS with Node in Docker

Run the same tests against the same PostgreSQL/Redis services and template, with matched Node/dependency versions, worker settings, profiling state, and cache conditions. The current Compose services do not publish database/Redis ports; a native runner needs a deliberate local connection path. Resolve ports from the current checkout and avoid development-service conflicts.

Account for environment loading, host-native dependencies, path aliases, ESM transforms, HTTP/MSW behavior, and source refresh. Launch through a documented npm script. Measure first use, unchanged rerun, and source-edit rerun. Compare both against the retained container design, not only the original slow setup.

Acceptance: report measured benefit and setup cost; prove test parity and clean reset behavior. Do not attribute Node import/context improvements to removal of Docker. Retain this option only if the benefit justifies a second execution path or replacement of the local path.

### T8 — Conditional experiments

Choose only an option supported by the remaining bottleneck:

- **Faster transforms or precompilation:** benchmark after cache reuse. Preserve decorator metadata, aliases, Jest mocks, and the custom ESM handling for `mdb-reader`, `ofx-js`, and `unpdf`. Follow dependency approval rules before adding a transformer.
- **Native PostgreSQL/Redis:** first collect service CPU/I/O and request-wait evidence. Compare compatible service versions and equivalent durability settings. PostgreSQL already uses a named volume with test-only durability reductions; do not count enabling those settings as a new improvement.
- **Different test runner/isolation:** prove a small representative slice with real HTTP coverage, mock parity, transaction behavior, and state isolation before proposing a migration. Account for conversion and maintenance cost.
- **Smaller daily test workload:** document focused HTTP selections and add fast logic tests only where they protect useful behavior. Report this as faster partial feedback, not a speedup of the unchanged full e2e suite. Retain required endpoint coverage.

Do not perform all experiments by default. Update the ranking after each measured improvement; stop when the remaining cost does not justify the change.

## Required handoff from each agent

Update the task status above and append a dated entry below with:

1. Task ID, source revision/diff, files changed, and the decision made.
2. Exact commands, environment/cache state, selected test counts, and artifact locations.
3. Baseline and candidate phase times, warm median/range, and relevant memory or restart evidence.
4. Checks passed, failed, skipped, or incomplete; any unresolved correctness or measurement limit.
5. The next bounded task and what evidence it needs.

Preserve raw results. Do not overwrite earlier captures or silently change the benchmark selection. Inspect the final diff and confirm no unrelated changes or commits. A performance claim is complete only when the measured benefit, correctness checks, and reproduction steps are recorded.

## Work log

- 2026-09-04: Investigation and container profiling complete. This plan was created from the reviewed findings. T0–T8 implementation has not started.


### 2026-09-04 — T0 complete

- Source remained at `1aa114beaa5ce131ad6e9342a370f52af11eb77d`. No application or runner change was retained. A temporary test-title edit proved source refresh and was restored. No commits were made.
- Results, exact npm commands, phase definitions, environment details, reproduction scripts, and raw logs: [`t0-baseline-20260905-0006/readme.md`](../packages/backend/node-profiles/t0-baseline-20260905-0006/readme.md). Artifacts were copied into this directory after measurement; prior captures and unrelated untracked files were preserved.
- Actual container: Node 23.11.0 / ARM64, Jest 29.7.0, four configured workers, existing 1 GB recycling threshold, 4 GB Node heap limit, CI unset, no CPU profiling. Colima stayed at 6 CPUs / 8 GiB. PostgreSQL 16.15 and Redis 7.4.11; exact image IDs and input hashes are retained.
- Three sequential warm trials per selection: small-suite total median **66.120 s** (63.492–66.449 s); fixed-batch total median **77.767 s** (75.418–83.475 s). Jest medians: **7.938 s** and **20.433 s**, respectively. Warm means Docker build layers only: services, migrated template, and container transform cache were fresh each run.
- First-use small run: **76.408 s**, with existing dependency/image cache and rebuilt source layers. Controlled source-edit run: **82.067 s**. Template preparation took **37.277–41.389 s** and cleanup took **10.727–11.281 s** across warm trials. Phase times are wall measurements; they are not CPU costs or promised savings.
- All eight invocations passed: 3 tests per small run and 218 tests in the exact saved 14-file selection per batch. No failures, skips, or retries were reported. Source restoration and final tracked diff checks passed. Existing services remained running. No memory or restart count was measured; process snapshots are not lifecycle evidence.
- Typecheck, lint, unit tests, and the full e2e suite were not run because T0 retains only documentation and measurement artifacts. There is no candidate comparison in this task. The earlier serial CPU profile is not a directly comparable speed baseline.
- Next bounded task: **T1**, persistent local services and a verified migrated template. Define cache validity, date refresh, reset, source refresh, and interrupted-setup recovery before implementation; then measure against this normal-runner baseline and run the required correctness checks.
