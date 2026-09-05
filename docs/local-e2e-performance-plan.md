# Local backend e2e performance plan

Status: T0–T2 complete; T3–T8 remain pending.
Evidence date: 2026-09-05 UTC.

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
| T1 | Persist local services and migrated template | T0 | Complete; full suite passed |
| T2 | Persist Jest transform cache | T0; integrate with T1 | Complete; validated and measured |
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


### 2026-09-05 UTC — T1 implemented; acceptance pending

- Source: `9a631da7` plus T1 changes. Added the local Compose override, local shell entry, template-key helper and unit tests, local preparation/test runner, and [usage/design documentation](local-e2e-runner.md). The existing entry script dispatches local runs to this path; CI retains its existing path. No dependency, application, migration, or existing test change was retained. No commit was made.
- Local PostgreSQL/Redis and a verified template persist under a Compose project derived from the canonical checkout path. Each invocation builds current source, uses a fresh one-off runner, recreates worker databases, and clears the isolated Redis service. `npm run test:e2e -- --reset` removes only this checkout's services/volumes; build caches remain. A PostgreSQL major upgrade requires reset first.
- The validity key covers recursive migrations, seed fixtures, dependency/configuration inputs, runner/verifier source, actual Node/PostgreSQL versions, architecture, and UTC day. Verification checks migration names, schema/enum/function/trigger definitions, and seed contents/dates. A database comment publishes validity only after verification succeeds. An advisory lock guards preparation and execution; do not overlap runs or change service configuration during a run.
- Exact commands, all raw captures, input hashes, images, phase tables, and recovery scripts are in [`t1-local-reuse-20260905/readme.md`](../packages/backend/node-profiles/t1-local-reuse-20260905/readme.md). Timing captures stayed outside the Docker build context until all checks finished. Earlier captures were preserved.
- Final warm trials (three per selection): small median **15.597 s** (15.104–16.702), versus T0 **66.120 s**; batch median **29.184 s** (28.338–29.700), versus T0 **77.767 s**. Median reductions: **50.523 s / 76.4%** and **48.583 s / 62.5%**. All final batches matched the saved 14-file / 218-test selection; each small run passed 3 tests. Normal four-worker/1 GB recycling settings, Node 23.11.0 ARM64, and Colima 6 CPUs / 8 GiB were retained. No CPU profiling or transform-cache persistence was used. Trials were collected in separate baseline/candidate blocks; uncontrolled host activity limits precision.
- Cold reset with warm build/image cache passed in **35.652 s** before the final verifier extension. Final-code trigger-corruption recovery passed in **33.801 s**. Intentional HTTP assertion failure proved source refresh and exit code 1; the edit was restored. Damaged schema, stale seed dates, worker/Redis sentinels, seed-change invalidation, killed migration setup with no published marker, recovery, and scoped reset all passed. Reset preserved five unrelated running services.
- Checks passed: 21 key/date unit cases, final container typecheck, backend lint, shell syntax, focused HTTP batches, recovery diagnostics, and restored-source/diff checks. Lint has existing warnings outside changed files. Host typecheck initially failed because its installed `ofx-js` module was missing; the lockfile-built container typecheck passed. No memory/restart or natural-shutdown claim is made; existing Jest forced-exit warnings remain.
- **Acceptance is not complete.** The final full e2e command ran to completion in **288.151 s**: **230 suites passed, 1 failed, 2 skipped; 2,630 tests passed, 1 failed, 52 skipped, 7 TODOs**. The failure was the import-batch filter at `src/services/transactions/get-transactions.e2e.ts:693` (expected 2 rows, received 0). That file passed all 16 tests alone under both T1 and the original runner. An earlier full attempt, stopped to finish schema verification, reported a securities-sync concurrency failure (429 versus expected 200); that file also passed all 13 tests under both runners. The cause of these full-run failures remains unproved.
- Per the stop-early rule, no further full-suite retry or speculative application/test fix was made. Next bounded work: investigate the full-suite-only failure with user direction before accepting T1. T2 remains pending.

### 2026-09-05 UTC — T1 full-suite failure investigation and acceptance

- Started from `788beadd` on `perf/testing`. No commit was made. Full evidence, commands, failed reproducers, result summaries, and the implementation diff are in [`t1-suite-isolation-20260905/readme.md`](../packages/backend/node-profiles/t1-suite-isolation-20260905/readme.md). Prior captures and both untracked directories were preserved.
- The import-batch failure depends on a preceding fully skipped file and Jest worker reuse. Setup creates queue workers, but Jest skips `afterAll` for files with no enabled tests. The skipped Microsoft Money file's CSV worker consumed a later file's import after its module runtime was torn down. The original full log contains that stack immediately before the batch failure. A two-file, one-worker npm reproducer failed with both T1 and the original `9a631da7` runner (3 failures, including the same empty batch). This proves the cause predates T1.
- A small Jest environment now awaits existing resource cleanup on `run_finish`, including skipped files, before module teardown. Cleanup errors propagate. The same two-file selection passed all 16 active tests after the fix. Import assertions also check row errors and imported count. Three focused unit tests cover cleanup timing, awaiting, and error propagation.
- The securities failure is separate: both requests used one admin, whose route allows one request per five minutes. A controlled provider gate reproduced 429 with the original 200 assertion. Two admins now test global lock contention (both 200; first stocks.ok true, second false); a separate same-admin case checks 429 and Retry-After. The gate distinguishes daily sync from holding history requests. No application/rate-limit code, retries, longer timeouts, or weaker lock assertions were added. The combined three-file selection passed 30 active tests.
- Final checks passed: 3 cleanup unit tests, backend lint, changed-file formatting, whitespace check, and typecheck in the final lockfile-built container. Host typecheck still lacks the already documented installed `ofx-js`; a test header typing error found during implementation was corrected. Lint has existing warnings outside this task.
- Required final `npm run test:e2e` passed on its first run after the fixes: **231 suites passed, 2 skipped; 2,632 tests passed, 52 skipped, 7 TODOs; exit 0; Jest time 268.564 s**. Default four-worker/1 GB recycling settings were retained. No performance comparison was repeated.
- **T1 acceptance is complete.** The prior service/template checks plus this full-suite result satisfy T1 validation. Jest still reports forced worker exit; this is recorded, and no full natural-shutdown claim is made. T2–T8 remain pending; no work on them was started.

### 2026-09-05 UTC — T2 implemented; validation deferred

- Source: `788beadd` plus T2 changes. The user authorized design and implementation while another worktree runs E2E tests, and explicitly prohibited tests until further authorization.
- Added a worktree-scoped Compose cache volume, conditional E2E cache configuration, a compatibility-key helper, and six focused unit cases. Updated the reset message and runner documentation. No dependencies or CI changes. No commits.
- Design: retain Jest's source invalidation within a directory keyed by runtime, lockfile/manifests, TypeScript/Jest configuration, and transformer inputs. Source edits keep the directory stable. Compatibility changes select a new directory. The existing scoped reset removes the entire cache volume. No date-based cache invalidation or application lifetime change.
- Static diff review, `git diff --check`, and `bash -n packages/backend/src/tests/setup-local-e2e-tests.sh` passed. Typecheck and lint remain pending. Tests, Docker builds/runs, cache/reset diagnostics, and benchmarks were not run. No T2 performance or correctness claim is made. No new measurement artifacts were created. T1 acceptance is complete per the upstream investigation above.
- Next bounded task, only after user authorization and after the other E2E run finishes: run the cache-key unit cases, typecheck/lint, then verify actual cache reuse, source-edit and transform-config invalidation, and scoped reset. Collect cold and three comparable warm small/batch trials against T1 with the same services/template state. Keep the template warm in both variants and report T2 savings separately. Run the full E2E suite for acceptance of this shared runner change.

- T2 rebase: fetched `dev-joss` and rebased onto `dev-joss/perf/testing` at `0dcc105d`. Preserved the upstream test environment cleanup and T1 acceptance record with the T2 cache changes. No tests were run during this rebase.


### 2026-09-05 UTC — T2 validation and acceptance

- Source: `0dcc105d` plus the T2 cache changes. The user authorized tests and continuing T2. No commit, dependency, CI, application, or existing test change was retained. The ignored `.env.test` was copied from the main checkout to enable this worktree's runner; its existing host launcher supplied `cross-env`, while Docker installed the locked test dependencies.
- **T2 accepted.** Raw logs, exact commands, input/image identities, reproduction scripts, phase tables, and cache snapshots are in [`t2-cache-validation-20260905/readme.md`](../packages/backend/node-profiles/t2-cache-validation-20260905/readme.md). Captures stayed outside the build context until all runs finished. Prior artifacts were preserved.
- Three alternating warm trials per variant/selection, same retained T1 image/services/template: small median **11.888 → 7.995 s** (baseline 11.646–18.862; candidate 7.691–8.271), a **3.893 s / 32.7%** reduction. Batch median **24.274 → 18.662 s** (baseline 24.155–24.361; candidate 18.323–19.319), a **5.612 s / 23.1%** reduction. Jest medians: **6.429 → 2.681 s** and **18.501 → 12.601 s**. Baseline uses a fresh container-local cache directory; candidate uses the persistent volume. These savings are separate from T1. One baseline small reset was slow; raw phase evidence retains it.
- All benchmark selections matched: 3 tests per small run; the original 14-file/218-test manifest in all six batches. Colima stayed at 6 CPUs / 8 GiB; Node 23.11.0 ARM64, Jest 29.7.0, four workers, 1 GB recycling, no profiling or retries.
- Full E2E suite passed: **231 suites passed, 2 skipped; 2,632 tests passed, 52 skipped, 7 TODOs; exit 0**. Jest **225.140 s**, command **230.83 s**. This is correctness evidence, not a matched full-suite speed claim. All 6 cache-key unit cases, container typecheck, host lint, shell syntax, and diff checks passed. Host lint retains unrelated warnings. Initial setup commands lacked `cross-env` and `.env.test`; container lint scanned dependency files and failed, then standard host lint passed. Details remain in the report.
- Unchanged reuse preserved all 3,556 transform files and mtimes. An intentional HTTP assertion change failed with exit 1; restoring it passed. A temporary transform/Jest config change selected a new cache directory and applied a one-test filter; restoration passed all 3 tests. The scoped reset removed the cache and other project test volumes while preserving all seven unrelated container IDs. The next cold run passed in **31.571 s** with warm image/build cache. The initial build/setup run passed in **83.78 s**. Fresh-cache batch trials used warm services/template; no fresh-services batch trial was collected.
- No natural-shutdown, memory, or restart claim is made; existing forced-exit warnings remain. Next bounded task: **T3**, one measured eager-import change and a resource-lifetime audit using the existing profile.
