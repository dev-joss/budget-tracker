# Expensify Work-Expense Reconciliation Plan

## 1. Goal

Integrate the Expensify Integration Server with Budget Tracker so a user can identify work expenses charged to personal cards and exclude them from personal spending calculations.

A work expense remains in the transaction ledger, transaction history, account balances, balance history, and net worth. It does not contribute to personal expense totals, category totals, budgets, cash flow, or savings statistics.

This plan uses `personal` as the implementation baseline. The branch `feat/expensify-work-expenses` is exactly based on `personal`. Its inherited OFX work is intentional baseline content.

## 2. Accepted product scope

- Use the Expensify Integration Server Report Exporter and Downloader jobs.
- Do not use the Expensify Reconciliation job.
- Do not use `markAsExported` or `markedAsExported`.
- Authenticate with employee-level `partnerUserID` and `partnerUserSecret` credentials.
- Import reimbursable expenses only from `SUBMITTED`, `APPROVED`, `REIMBURSED`, and `ARCHIVED` reports.
- Match against transactions in all active credit-card accounts owned by the user.
- Match one Expensify expense to one complete local transaction. Do not support splits or partial matches.
- Require confirmation before a suggested match changes a transaction.
- Permit bulk confirmation of exact matches only.
- Permit manual work-expense marking and unmarking without an Expensify record.
- Make manual decisions authoritative over later synchronization.
- If imported data disappears, becomes ineligible, or changes materially, keep the classification and flag the link for review.
- Provide manual synchronization through **Sync now** for the MVP.
- Disconnect by removing credentials while retaining classifications, imported metadata, links, and review history.
- Do not identify or link employer reimbursement deposits in this version.

The employee proof succeeded with seven reports and 42 unique reimbursable expenses. Report Exporter, JSON FreeMarker output, and Downloader access are therefore known to work without an `employeeEmail` filter.

## 3. Data invariants

1. `isWorkExpense` is the effective transaction classification.
2. Classification does not change transaction money, type, account, category, payee, balance history, or account balance.
3. Synchronization never classifies a transaction without confirmation.
4. Each expense and transaction can participate in at most one confirmed Expensify link.
5. A link covers the full transaction.
6. Manual mark or unmark remains effective through all future synchronizations.
7. Upstream disappearance or change never reverses a classification automatically.
8. Credentials never enter logs, queues, Redis state, SSE messages, API responses, backups, or human-readable exports.
9. All money values use `Money`; the database uses cents and APIs use decimals.

## 4. Repository boundaries

Read and follow:

- `.claude/docs/backend-conventions.md`
- `.agents/skills/frontend-rules/SKILL.md`
- `.agents/skills/e2e-test-creator/SKILL.md`

Important implementation areas:

- Transaction model and serialization:
  - `packages/backend/src/models/transactions.model.ts`
  - `packages/backend/src/models/transactions-balance-relevance.ts`
  - `packages/backend/src/serializers/transactions.serializer.ts`
  - `packages/shared/src/types/db-models.ts`
- Shared transaction query boundary:
  - `packages/backend/src/models/transactions-query/`
- Statistics:
  - `packages/backend/src/services/stats/stats-transactions.ts`
- Budgets:
  - `packages/backend/src/services/budgets/stats.ts`
  - `packages/backend/src/services/budgets/spending-stats.ts`
  - `packages/backend/src/services/budgets/get-category-budget-transactions.ts`
  - `packages/backend/src/services/budgets/create-budget.ts`
  - `packages/backend/src/services/budgets/add-transactions-to-budget.ts`
- Encryption and redaction:
  - `packages/backend/src/common/utils/encryption.ts`
  - `packages/backend/src/services/bank-data-providers/utils/credential-encryption.ts`
  - `packages/backend/src/services/user-settings/redact-key-material.ts`
- Queue and SSE precedents:
  - `packages/backend/src/services/ai-categorization/categorization-queue.ts`
  - `packages/backend/src/services/ai-categorization/categorization-status.service.ts`
- Backup, export, and wipe:
  - `packages/backend/src/services/backup/registry.ts`
  - `packages/backend/src/services/data-export/registry.ts`
  - `packages/backend/src/services/user/wipe-user-data.service.ts`
  - `packages/backend/src/services/user/user-destroy-lifecycle.ts`
- Frontend entry points:
  - `packages/frontend/src/pages/settings/settings.vue`
  - `packages/frontend/src/pages/optimizations/index.vue`
  - `packages/frontend/src/components/transactions-table/transaction-table-row.vue`
  - `packages/frontend/src/components/transactions-list/transaction-record.vue`
  - `packages/frontend/src/components/dialogs/manage-transaction/dialog-content.vue`

## 5. Schema and migration

Before implementation, inspect migration state against both the intended baseline and the repository migration line:

```bash
git diff --name-status personal...HEAD -- packages/backend/src/migrations
git log --oneline dev..HEAD -- packages/backend/src/migrations
git status --short packages/backend/src/migrations
```

Create one new Expensify migration. Do not amend the unrelated OFX migration.

### 5.1 Transaction classification

Add to `Transactions`:

- `isWorkExpense BOOLEAN NOT NULL DEFAULT false`
- `workExpenseSource VARCHAR(20) NULL`, restricted to `manual` or `expensify`

Manual operations set `workExpenseSource=manual`, including an explicit manual unmark. Confirmation can set `expensify` only when no manual decision exists.

Do not add classification to `BalanceRelevantSnapshot`. Classification changes must not generate balance rows.

Adding transaction columns requires recreation of the `real_transactions` view through `packages/backend/src/migrations/utils/real-transactions-view.ts`. The down migration must drop the view, remove columns, and recreate the view.

### 5.2 `ExpensifyConnections`

- UUID primary key
- Unique user foreign key with cascade deletion
- Encrypted credential payload in `TEXT`
- Initial synchronization date
- Credential revision number
- Last attempted and successful synchronization timestamps
- Safe last-error code
- Standard timestamps

The encrypted payload contains both credential values. No serializer may expose it.

### 5.3 `ExpensifyExpenses`

- UUID primary key
- User foreign key
- Unique `(userId, externalExpenseId)`
- External report ID and report state
- Original amount in cents using `Money`
- Original currency and date
- Original and modified merchant values
- Reimbursable state
- Upstream fingerprint and last-seen synchronization information
- Match state: `exact`, `likely`, `ambiguous`, `unmatched`, or `review`
- Nullable linked transaction with `ON DELETE SET NULL`
- Confirmation tier, time, and fingerprint
- Review reasons and review baseline
- Partial unique index on non-null linked transaction ID
- Indexes for user/state and user/report queries

### 5.4 `ExpensifyMatchCandidates`

- User, expense, and transaction foreign keys
- Unique `(expenseId, transactionId)`
- Rank
- Composite and merchant similarity scores in basis points
- Date distance
- Reciprocal-top marker
- Transaction index for conflict detection

Use string fields plus database checks instead of new PostgreSQL enum types. Register all models in `packages/backend/src/models/index.ts`.

## 6. Backend API

Mount `/api/v1/work-expenses` from `packages/backend/src/setup-routes.ts`.

Add:

- `GET /integration`: safe connected or disconnected state.
- `PUT /integration`: validate credentials with a small read-only export before encrypting and storing them.
- `DELETE /integration`: clear credentials, increment credential revision, and cancel waiting work. Keep reconciliation data.
- `POST /sync`: enqueue a manual synchronization and return `202`; return `409` if one is already active.
- `GET /sync/status`: return safe state, counters, and allowlisted error codes.
- `GET /reconciliation`: paginate and filter imported expenses, candidates, links, and review reasons.
- `POST /matches/confirm`: confirm one selected match or at most 100 exact matches.
- `DELETE /matches/:expenseId`: remove a wrong link without reversing classification.
- `POST /reviews/:expenseId/resolve`: keep the link or relink to a selected transaction.
- `PATCH /transactions/:id/work-expense`: manually mark or unmark an editable real expense.

Use route/controller/service separation, Zod validation, object-like function parameters, `withTransaction`, and existing authorization helpers. Apply the base-currency lock to confirmation, relinking, and manual classification because they change reporting inputs. Explicitly cover exempt connection and synchronization routes in the base-currency guard test. Block demo users from storing credentials or calling Expensify.

Every new endpoint requires HTTP-only E2E happy-path, empty-state, and error coverage.

## 7. Expensify client

Create a focused client under `packages/backend/src/services/work-expenses/expensify/` using the installed Axios dependency.

The URL is fixed:

```text
https://integrations.expensify.com/Integration-Server/ExpensifyIntegrations
```

Exporter request:

- `type=file`
- `inputSettings.type=combinedReportData`
- `reportState=SUBMITTED,APPROVED,REIMBURSED,ARCHIVED`
- `outputSettings.fileExtension=json`
- `onReceive.immediateResponse=[returnRandomFileName]`
- Date windows no longer than one year
- No `onFinish`

Downloader request:

- `type=download`
- Filename returned by the exporter
- `fileSystem=integrationServer`

The static FreeMarker template must return strict JSON with report ID/state and expense ID, original amount, currency, date, original/modified merchant, and reimbursable state.

Safeguards:

- Fixed URL and static template to prevent SSRF or template injection.
- Request timeout and bounded filename, response-byte, and expense-count limits.
- Zod validation after JSON parsing.
- No request-body or raw upstream-body logging.
- Retry only network errors, 429, and 5xx with bounded exponential backoff and jitter.
- Serialize calls per connection and remain below Expensify rate limits.
- Convert upstream failures to safe authentication, rate-limit, unavailable, and invalid-response codes.

Keep sanitized fixtures for JSON escaping, empty exports, modified values, and malformed output. Never use live credentials in tests.

## 8. Synchronization

Use BullMQ and the existing status/SSE pattern. Queue payloads contain only user ID, synchronization run ID, and safe trace data. Workers load and decrypt credentials at execution time.

Use a per-user Redis lock and status pointer. Store only safe status data. Add queue cleanup to integration-test setup.

Synchronization sequence:

1. Load the connection and credential revision.
2. Decrypt credentials in function-local memory.
3. Fetch discovery windows.
4. Refresh known report IDs in chunks so older records can change.
5. Parse and validate all files before writes.
6. Deduplicate external expense IDs.
7. In one database transaction, upsert eligible expenses, retain known expenses that became ineligible, detect changes/disappearance, rebuild affected unconfirmed candidates, update states, and record success.
8. Publish terminal safe status.

If any fetch or parse fails, do not perform disappearance detection and do not update `lastSuccessfulSyncAt`.

Material changes include original amount, currency, date, reimbursable state, report eligibility, disappearance, or a material normalized merchant change. Movement among the four eligible report states is metadata only.

Disconnect increments the credential revision. Workers check it before each upstream phase so no later request starts with disconnected credentials.

## 9. Matching

Candidate hard filters:

- Same user
- Active account
- Credit-card account category
- Real expense transaction
- Not planned, transfer, or balance adjustment
- Not linked to another Expensify expense
- Exact original cents and ISO currency
- Calendar date within three days

Use transaction `originalAmount` and `originalCurrencyCode` when both exist; otherwise use transaction amount and account currency. Never use reference/base-currency amount.

Resolve the local merchant from payee name first, provider merchant metadata second, and transaction note last. Reuse the repository payee normalization and installed Fuse.js dependency.

Initial deterministic scoring:

- Amount and currency are hard gates.
- Merchant similarity is `1 - FuseScore`.
- Date score is `1 - dateDistance / 3`.
- Composite score is 80% merchant and 20% date.
- Plausible merchant threshold: 0.60.
- Likely composite threshold: 0.72.
- Required top-versus-runner margin: 0.12.

States:

- `exact`: normalized merchant equality, same date, and reciprocal unique edge.
- `likely`: reciprocal top candidate that passes threshold and margin.
- `ambiguous`: contested transaction, multiple plausible candidates, or no dominant candidate.
- `unmatched`: no plausible candidate.
- `review`: a confirmed link has changed or ineligible upstream/local data.

Bulk confirmation accepts reciprocal unique exact edges only. Confirmation locks expense and transaction rows, revalidates ownership and eligibility, and relies on the unique index as the final concurrency guard. Return `409` for stale or conflicting choices.

## 10. Reporting and budgets

Add a non-overridable `isWorkExpense=false` fragment to `packages/backend/src/services/stats/stats-transactions.ts`. This covers cash flow, cumulative data, expense history, category totals, period expense totals, pivot reports, savings calculations, net-worth-driver savings input, and investment-contribution savings input.

Also exclude work expenses from `get-earliest-transaction-date.ts` so work-only history does not extend personal analytics controls.

Add explicit filters to direct budget reads:

- Manual budget totals and breakdowns
- Category-budget totals and transaction lists
- Split-parent includes
- Manual-budget auto-include
- New manual-budget attachment validation

Do not delete existing budget junction rows when a transaction becomes work-related. The link remains hidden and becomes effective again after a manual unmark.

Do not change balance history, total balance, combined balance history, net-worth history, account queries, or normal transaction-list queries.

Refund behavior remains a decision: the recommended rule is to exclude a merchant refund linked to a work expense from personal reporting. This is separate from employer reimbursement deposits.

## 11. Frontend

### Settings

Add `/settings/work-expenses` with:

- Disconnected credential form
- Connected state with no returned credential values
- Last successful synchronization and safe error state
- **Sync now** action
- Link to reconciliation review
- Disconnect confirmation

Never prefill password fields. Clear the local secret immediately after submission.

### Reconciliation

Add a Work Expenses optimization route and card. The reconciliation page contains state filters, imported-expense rows, candidates, exact bulk selection, review reasons, and resolution actions.

Use TanStack Query and add appropriate keys to `packages/frontend/src/common/const/vue-query.ts`. Classification and confirmation mutations invalidate reconciliation data and the existing transaction-change prefix so statistics, budgets, and lists refresh.

### Transaction UI

Show a work-expense indicator in table rows, compact records, and the transaction-details dialog. The details dialog provides a dedicated immediate mark/unmark control subject to edit permission. It does not alter the existing general edit payload.

Show source and review state, such as **Work expense — Manual**, **Work expense — Expensify**, and a linked-data review warning.

### Responsive design

Make the reconciliation root a named CSS container. Use container-query variants for stacked narrow cards and a wide two-pane mapping layout. Do not use page-level viewport breakpoints or `window.innerWidth`.

## 12. Security and lifecycle

- Encrypt the two credentials as one JSON payload with existing AES-256-GCM utilities.
- Do not add new cryptography or a dependency.
- Select ciphertext only in connection, credential-update, and worker services.
- Validate replacement credentials before replacing a working connection.
- Keep old ciphertext when validation fails.
- Never send credentials through BullMQ, Redis, SSE, Sentry metadata, logs, backup, or data export.
- Store only allowlisted error codes.
- Disconnect nulls ciphertext and increments the revision.
- Treat an application encryption-key change as a reconnect condition for MVP.
- Rotate the proof credential before production use because it was shared in conversation.

## 13. Backup, export, wipe, and deletion

Register new tables in backup order after users and transactions. Strip credential ciphertext during dump and restore the connection as disconnected. Preserve classification and reconciliation links. Bump the backup format if required by the registry compatibility rules.

Add `WorkExpense` and `WorkExpenseSource` transaction-export columns and a work-expense reconciliation export domain without credentials. Ensure exported budget totals exclude work expenses.

Update user wipe to remove connection, expenses, candidates, pending jobs, and Redis status because wipe retains the user row. Full user deletion can use foreign-key cascades.

Transaction deletion sets a confirmed expense link to null and leaves it as a review item.

## 14. Testing

Backend E2E tests must act through HTTP helpers and mock only the external Expensify boundary.

Cover:

- Connected and disconnected integration states
- Valid and invalid credential connection
- Safe credential replacement and disconnect
- Empty and successful synchronization
- Upstream failure and concurrent trigger
- Eligible-state and reimbursable filtering
- Idempotent upserts
- Disappearance and material changes
- Reconciliation pagination and user isolation
- Exact bulk and individual likely/ambiguous confirmation
- Stale candidates and duplicate transaction conflicts
- Unlink, review acknowledgment, and relinking
- Manual mark/unmark without Expensify
- Manual precedence through all sync changes
- Active-card scope and rejection of inactive/non-card/planned/transfer/adjustment candidates
- Absence of credentials from every response, log, job, SSE event, backup, and export
- Work-expense exclusion from each statistics and budget path
- Continued inclusion in transaction history, balances, balance history, and net worth
- Backup round-trip, export, wipe, and real-transactions-view behavior

Unit-test the template fixtures, upstream schema, cents parsing, fingerprints, change rules, matching boundaries and ties, deterministic ordering, manual precedence, and credential-free queue payload.

Frontend unit and Playwright tests cover connection, empty sync, review states, exact bulk confirmation, manual classification, disconnect retention, query invalidation, and narrow/wide container layouts.

All test execution must use the `test-runner` subagent. Never run backend E2E suites concurrently. All lint and type checks must use the `linter` subagent.

## 15. i18n

Use the `i18n-editor` subagent for all locale-file reads and edits. Add English keys only for settings, integration states, sync status, match states, review reasons, confirmations, errors, and notifications. Leave other locales to Crowdin.

Use **Work expense** consistently unless product copy changes.

## 16. Rollout order

1. Resolve the remaining decisions in section 17.
2. Add schema, models, shared types, backup registration, and wipe behavior.
3. Add manual classification and all reporting/budget exclusions.
4. Add the Expensify client and sanitized contract fixtures.
5. Add connection endpoints.
6. Add synchronization queue, status, and snapshot import.
7. Add matching, confirmation, unlink, and review endpoints.
8. Add backup and human-readable export behavior.
9. Add settings, reconciliation, and transaction UI.
10. Delegate English i18n work.
11. Use linter and test-runner subagents for focused checks.
12. Run one sequential regression E2E selection for work expenses, statistics, budgets, backup, export, wipe, and view compatibility.

Deploy the backward-compatible migration before workers/API and deploy the frontend only after the complete backend behavior is available.

## 17. Remaining decisions and proposed defaults

1. **Initial history:** default to the previous 12 months and allow an earlier date; split longer history into one-year windows.
2. **Shared cards:** match only cards owned by the credential owner for MVP.
3. **Manual eligibility:** permit any editable real, non-transfer expense, not only card expenses.
4. **Merchant field:** match modified merchant when present, otherwise original merchant; retain both.
5. **Merchant refunds:** exclude a refund linked to a work expense from personal reports.
6. **Review actions:** offer Keep as work expense, Choose another transaction, and Remove match; never reverse classification automatically.
7. **Local edits:** retain classification and flag review after a material edit to a linked local transaction.
8. **Template contract:** confirm sanitized empty-export and JSON-escaping behavior against Expensify before rollout.

## 18. Acceptance criteria

- Credentials are encrypted, backend-only, and absent from responses, logs, jobs, exports, and backups.
- Synchronization uses only Report Exporter and Downloader and does not mark reports exported.
- Only reimbursable expenses from the four accepted states enter reconciliation.
- Matching uses original cents, currency, date within three days, and merchant similarity across active owned card accounts.
- Database and services enforce one-to-one links.
- Exact matches support bulk confirmation; all other choices require explicit selection.
- Manual mark/unmark works without Expensify and wins over imports.
- Changed, missing, or ineligible imports retain classification and become review items.
- Work expenses remain visible and balance-relevant.
- Work expenses are absent from all named personal statistics and budget paths.
- Disconnect removes credentials and preserves classifications and reconciliation data.
- Backup/restore preserves non-secret state and restores the integration disconnected.
- Wipe removes all Expensify state and pending work.
- The interface works in narrow and wide content containers.
- Every new endpoint has HTTP-only E2E happy, empty, and error coverage.
- Required unit, E2E, lint, type, and frontend checks pass through the required subagents.
- No commits or pushes are created by agents.
