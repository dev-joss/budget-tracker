# AI-assisted payee extraction plan

Status: implemented and verified on `codex/ai-payee-extraction`.

Issue: [dev-joss/budget-tracker #5](https://github.com/dev-joss/budget-tracker/issues/5).
Research date: 2026-09-05.
Implementation baseline: `dev-joss/personal` at `c5778bcab9784417018696837d1e4fe20349b593`.
The feature branch starts from the remote `personal` branch, which includes the merged Plaid work.

Add a background AI fallback for imported transactions that still have no payee after deterministic resolution. Apply only high-confidence results. Keep imports successful when extraction cannot run. Provide an explicit action to process unresolved history.

The user selected both bank-provider and file imports. The user also selected an unresolved list with normal manual payee assignment for low-confidence results. Do not store AI suggestions or add a suggestion-approval workflow.

File scope includes CSV, YNAB, BudgetBakers Wallet, Microsoft Money, OFX/QFX, and statement-parser transactions in the normal transaction ledger. Investment holdings and investment cash records use separate models and are outside this issue. Preserve existing file-import payee mappings. Several importers already create a payee from a supplied payee column; those linked rows do not enter this fallback. This work will not merge existing noisy payees or replace existing assignments.

## Feature behavior

```text
Committed imported rows
  → select eligible rows using account ownership
  → provider/source merchant + exact canonical/alias match
  → existing deterministic fuzzy and occurrence rules
  → opted-in description matching
  → batch the remaining descriptions for AI
  → validate output and confidence
  → recheck current row, settings, ignored names, and payee namespace
  → create/reuse payee, save exact alias, and link eligible rows
```

The worker must enforce this order. Independent timers for deterministic matching and AI do not establish an order.

Use `0.95` as the initial acceptance threshold, held in a named backend constant. Require a finite numeric confidence in `[0, 1]`; do not coerce strings or clamp invalid values. Treat the score as a model estimate and test its behavior with fixed examples. Results below the threshold remain unlinked.

Reuse the existing AI provider layer, credentials, model selection, error classification, and BullMQ queue. Add no package dependency, separate queue infrastructure, or new payee table.

## Repository findings

| Area | Existing behavior and plan consequence |
| --- | --- |
| `services/payees/resolve-payee-for-incoming-row.ts` | Dedicated merchant input takes precedence. Description use requires `payeeExtractionUsesDescription`. Keep this permission boundary. |
| `services/payees/extraction.service.ts` | Resolves exact names/aliases, fuzzy matches, and occurrence promotion. Its prior-row scan assumes the current row has not been inserted. Backfill needs a stored-row mode to avoid counting the candidate twice. |
| `services/payees/note-fuzzy-backfill.ts` | Uses account ownership, applies category/tag rules, and guards the payee update. It must also check the affected-row count before related writes. |
| `services/payees/payee-namespace.ts` | Resolves canonical names and aliases per owner. Alias uniqueness is only `(payeeId, normalizedName)`; it does not enforce uniqueness across all payees owned by one user. |
| `services/bank-data-providers/plaid/transaction-mapper.ts` | Currently places `transaction.name` in `rawMerchantName` when `merchant_name` is absent. Keep source provenance explicit so the fallback cannot bypass the description setting. |
| `services/payees/extraction.service.ts` | The remote baseline already reads nested `externalData.plaid.merchantName`. Extend this reader; do not add a competing Plaid reader. |
| `services/ai-categorization/categorization-queue.ts` | The current queue, worker handlers, status pointer, and SSE events all assume categorization. Reuse requires explicit job dispatch and separate extraction status. |
| `models/user-settings.model.ts`, `services/ai/resolution-ladder.ts` | AI settings contain model/credential configuration but no extraction consent flag. Server credentials can be selected without a user key. Configuration is not consent. |
| File import execute services | File imports do not all emit the bank-sync event. Statement import schedules categorization separately. Add extraction hooks without causing new categorization runs in other importers. |

Backend paths in this table are relative to `packages/backend/src/` on the proposed baseline.

## Work packages

1. **Define eligibility, consent, and shared contracts.**

   Add `AI_FEATURE.payeeExtraction` to the existing feature configuration, model defaults, recommendation map, and frontend selector. Use models already supported by the project, including OpenRouter and custom endpoints. Do not add category-specific custom instructions to extraction prompts.

   Add `payeeAiExtractionEnabled`, default `false`, to the existing user-settings schema and update API. Require both this switch and `payeeExtractionUsesDescription` for description-based AI processing, including backfill. Explain the resolved destination in the UI. A configured key, statement-parsing consent, or a backfill button alone must not bypass a disabled setting. Recheck settings before each model call and before applying results.

   Preserve the resolver's custom-endpoint privacy rules. A failed custom endpoint must not cause a cloud fallback. Reuse failure classification and credential invalidation, but stop extraction if recovery would change the disclosed processing destination. Offer retry after the user fixes AI settings.

   Define one candidate predicate for the list, automatic jobs, backfill, and writes: the requester owns the account; the row has import provenance; `payeeId IS NULL`; `payeeLocked = false`; it is a real ledger row with a usable description. Exclude balance adjustments, transfer rows, and provider-removed rows. The first version processes normal income and expense rows. Include imported ordinary income and expense rows. Use `Account.userId`, not the transaction creator, to select the payee namespace and AI settings.

   Recognize file `externalData.importDetails`, provider metadata, and retained bank provenance after account disconnection. Do not infer import provenance from a note or current account type alone. Treat selected IDs and account filters as restrictions on this predicate. Reject invalid or unauthorized account scopes.

2. **Make deterministic resolution safe for stored rows.**

   Reuse normalization, exact namespace lookup, fuzzy matching, and the existing occurrence threshold. Separate resolution decisions from transaction linking where needed. A stored row must not count itself as a prior occurrence. Promotion requires at least two distinct eligible transactions. Evidence may be read from owned history, but writes must stay within the run's selected rows.

   Preserve the provider-merchant-first order and the description setting. Handle empty and whitespace-only merchant fields consistently. Fix the Plaid description-as-merchant path so source descriptions use the same setting as other providers. This is a behavior change for users who have that setting off and needs a regression test.

   Recheck exact aliases immediately before an AI request. A mapping accepted by an earlier batch should make a later batch deterministic. Do not call the existing incoming-row resolver unchanged from backfill.

   Harden the reused write paths: recheck unlinked/unlocked status and current ownership, count actual affected rows, and apply category/tag rules only after a successful link. Remove description-bearing logs from the payee paths used by the new worker.

3. **Add the bounded AI extraction service.**

   Group identical source descriptions within an owner. Start with at most 50 distinct descriptions per model request, plus an input/output token limit using existing tooling. Also bound row pages and queued ID lists: one description can represent many transactions. Split oversized batches before sending them. Skip source text that cannot fit the existing alias length limit, with a reason count; do not truncate it into an ambiguous alias.

   Send only a temporary batch ID and the source description. Prefer retained source text where available; use the imported row's note only as the description covered by the existing setting. Do not add amounts, account names or IDs, account numbers, full provider JSON, or other fields to the prompt. Treat description contents as data; the model must not follow instructions found in them.

   Require structured output with this shape:

   ```ts
   {
     results: Array<{
       id: string;
       sourceDescription: string;
       normalizedPayeeName: string | null;
       confidence: number;
     }>;
   }
   ```

   Match each ID and echoed description to the exact submitted input. Normalize accepted payee names again on the server and enforce the existing name limits. Reject unknown IDs, duplicate/conflicting entries, invalid confidence, and empty or invalid names. Missing entries remain unresolved. Reject a malformed or truncated response as a batch failure. A valid null name or low-confidence result is an unresolved outcome, not a provider failure.

   Use `createAIClient`, `aiCallGuards`, the current output ceiling checks, and `classifyAiCallFailure`. Apply bounded retries only to retryable failures. Do not repeatedly retry low-confidence output. Pass only sanitized error codes and aggregate counts to logs, Sentry, queue failures, status responses. Do not copy the categorization response-preview logging.

4. **Apply accepted mappings atomically.**

   Make the model call outside a database transaction. Apply each accepted mapping in a short transaction. Acquire the owner's payee namespace lock before namespace reads and payee/transaction row locks. Re-read candidate rows under lock and verify eligibility and source text have not changed since the request.

   Check the normalized source and target against canonical names, aliases, and ignored names. Existing exact user mappings remain authoritative. If a new AI mapping conflicts with another payee or ignored name, leave it unresolved; never move an alias or merge payees automatically.

   Create or adopt the target through the existing transaction/savepoint helpers. Save each accepted source as an exact alias. Guard the transaction update and use the affected-row count. Apply the existing payee category precedence and add-only tag rules only to rows actually linked, while holding the row lock. Preserve manual category decisions as well as manual payee decisions. If no selected row is still eligible, do not create an orphan payee or alias.

   Add a shared namespace advisory-lock helper at the core create, rename, alias-create, merge, extraction, note-backfill, and delete/ignore service boundaries. AI-only locking is insufficient because existing writers could otherwise claim the same normalized name concurrently. Establish one lock order and inspect outer import transactions, which can extend lock lifetime. Keep existing unique indexes and `insertOrAdopt` as additional protection.

   Reuse aliases as the durable accepted-mapping cache. Repeated descriptions then resolve without AI. A previously unseen changing suffix may still need fuzzy matching or another AI call; do not add broad wildcard aliases. No new mapping migration is planned.

5. **Integrate jobs and import completion.**

   Extend the current BullMQ job contract with an extraction discriminator and worker dispatch. Jobs without the discriminator remain categorization jobs. Keep existing categorization entrypoints and behavior. Dispatch completed/failed handlers, progress, terminal outcomes, and status lookups by job type as well as the processor itself.

   Use extraction-specific run IDs and status keys. The UI polls the status endpoint; no new SSE event is needed. Do not overwrite the categorization pointer or send category notifications for extraction. Queue data contains IDs/scope, run state, and trace context only; load descriptions from the database when processing.

   Use bounded durable jobs, deduplicate identical active source revisions, and serialize extraction per owner across automatic and explicit runs. A job that cannot acquire the execution gate must remain pending for later processing. New import IDs must not be dropped because another run is active. Use token-owned release and gate renewal/recovery for long calls. Track completed batches for retry, and recheck aliases and eligibility after restart. Database writes must remain idempotent even if a model request is repeated after a crash. Each new run has fresh status and occurrence evidence. A crash after a database link but before its checkpoint can count that row as skipped on retry; it cannot repeat the link or related writes.

   Schedule bank extraction from committed sync results. Make the worker finish deterministic processing before it selects AI candidates. Add a common extraction scheduling helper to file-import completion paths for all supported formats. Do not emit `TRANSACTIONS_SYNCED` from file imports as a shortcut because that also triggers categorization.

   Include committed imported rows from partial imports and eligible rows that became real through planned-row matching. Preserve assigned or locked payees on those rows. Do not change an import's existing created/merged counts to collect enrichment IDs. Cover provider updates that leave a row unresolved and change its source text.

   Catch enqueue, model, validation, and apply failures at the enrichment boundary. They must not roll back committed imports or mark a bank sync failed. If enqueue fails, unresolved rows remain available to explicit backfill. Coordinate payee category rules with existing categorization in both completion orders: a delayed category result must not overwrite an enforced payee rule, and a late payee link in `hint` mode must not replace a completed AI category or clear its metadata. Add a late-link guard to the shared rule application where needed; hint remains a fallback.

   Ensure all workers understand the new job type before producers can enqueue it. The feature stays off by default during deployment.

6. **Add the backfill API and unresolved-list UI.**

   Add authenticated route → controller → service endpoints, following the current payee route layout:

   | Proposed endpoint | Contract |
   | --- | --- |
   | `GET /payees/extraction/candidates` | Paginated unresolved imported rows and eligible count, optionally restricted to owned accounts. No AI request. |
   | `POST /payees/extraction/trigger` | Start a run for selected nonempty IDs or all unresolved rows in the selected owned-account scope. Return `runId`, status, and count; return an empty success when there is no work. |
   | `GET /payees/extraction/status?runId=...` | Owner-scoped run status, aggregate outcome counts, and a sanitized stop reason. |

   Put **Resolve payees** on Transactions Optimizations, with a link from Payee Settings. Show account selection, unresolved rows, AI configuration state, the processing destination, and a **Process unresolved transactions** action. Require explicit selection of the run scope. Use existing transaction editing for manual assignment. Low-confidence rows stay on this list without stored suggestions.

   Put the new AI extraction switch next to the existing description switch in Payee Settings. Explain that it enables both automatic extraction and explicit backfill. The backfill button must not turn either setting on. Disable duplicate start actions while the same backfill is active. Return a conflict for overlapping explicit runs; automatic work remains queued.

   Scan large histories with bounded keyset pages and a fixed run cutoff, not offset paging over a shrinking unresolved set. Include continuation/checkpoint state so completed pages are not lost on retry. New imports belong to their own queued work. Persist terminal run counts long enough for reload, following existing Redis status conventions. Add the current server-funded rate-limit policy under an extraction-specific key.

   Report `scanned`, `linked`, `skipped`, `lowConfidence`, and `failed` as row counts with mutually exclusive final outcomes: `scanned = linked + skipped + lowConfidence + failed`. Count model requests, distinct descriptions, and token use separately. Show partial completion and actionable configuration failures. Add only the necessary English locale keys.

7. **Verify the feature and its existing boundaries.**

   Add focused tests as each package lands. Backend E2E setup and actions must use HTTP endpoint helpers; mock provider/model HTTP traffic with existing test tools. Do not call feature services directly from E2E tests. Cover every new endpoint's happy path, empty state, and error behavior.

   | Test group | Required coverage |
   | --- | --- |
   | AI unit tests | Prompt data boundaries; strict parsing; unknown/duplicate IDs; source mismatch; null name; malformed/truncated output; confidence below, at, and above `0.95`; range/type failures; name limits; batching. |
   | Deterministic unit tests | Provider merchant precedence; description setting; aliases avoid AI; exact/fuzzy fallbacks; ignored names; one stored occurrence does not promote itself. |
   | Amazon HTTP E2E | Plaid `merchant_name = null` with both issue descriptions; mocked high confidence produces one Amazon payee and links both rows; later exact descriptions require no AI call. |
   | File-import HTTP E2E | Each supported format reaches scheduling when it has eligible rows; supplied payees stay unchanged; representative CSV/OFX/statement unresolved rows reach the worker; blank descriptions and duplicate-only imports do not call AI. |
   | Backfill HTTP E2E | All/selected/account scope; empty ledger; no candidates; missing/disabled AI; invalid scope; foreign account/run denial; repeated trigger; low confidence; invalid output; provider/Redis failure; large-history continuation. |
   | Concurrency HTTP E2E | Overlapping sync and backfill; concurrent payee/alias creation; cross-payee namespace conflict; worker retry; manual assignment, manual clear with lock, source edit, account move, or deletion while the model is paused. |
   | Ownership and rule E2E | Owner's payees/settings for recipient-authored rows; no foreign-user aliases; ignored source and target; planned/internal-transfer exclusions; category/tag precedence in both AI completion orders, including late `hint` links; zero-row link does not apply rules. |
   | Failure and privacy tests | No model request before consent; consent revoked mid-run; no cloud fallback from a private endpoint; sanitized logs and errors; AI or enqueue failure leaves bank/file import successful. |
   | Frontend tests | Consent and configuration state; scope selection; empty state; reload/progress; partial failure; manual assignment removes a row from the unresolved list; extraction status does not affect categorization status. |

   Run relevant existing payee, Plaid, file-import, AI configuration, and categorization regressions. Run backend E2E suites sequentially through the repository scripts. After tests, run backend/frontend type checks and lint for the changed code. No dependency or infrastructure change is part of this plan.

## Completion and validation

The feature is complete when issue #5's acceptance criteria pass for bank and file imports, backfill processes history without reconnecting accounts, concurrent processing cannot duplicate mappings or overwrite protected rows, and failures preserve successful imports.

Planning validation included issue #5, its comments, repository conventions, related source and tests, and the remote branch. Independent implementation review found and resolved source-update scheduling, ignored-merchant, and lock-order defects. Final test results are recorded below.


### Implementation validation — 2026-09-05

- Backend HTTP integration tests: 297 passed across 26 suites. This includes the extraction API, exact Amazon/Plaid case, automatic CSV success and model failure, 201-row continuation, consent changes, concurrent manual edits, all file importers, payee rules, planned matching, AI settings, account linking, and user deletion/wipe.
- Backend unit tests: 108 passed across 15 suites. The final scheduling test also covers a missing retained job without publishing an orphan queued status.
- Frontend unit tests: 23 passed across 3 files for extraction scope/state, API serialization, and custom endpoint selection.
- Backend and frontend type checks passed. Lint passed with existing repository warnings. Changed-file formatting and whitespace checks passed.
- The first extraction integration run had three failures in query serialization and test ID validation. These were corrected and rerun successfully. Microsoft Money initially skipped 21 tests because public fixtures were absent; the repository fixture script downloaded them, and all 21 then passed.
- Some existing integration suites emitted Jest worker teardown warnings. All final test commands exited successfully.

No live model request or browser smoke test was run. Model HTTP responses were mocked; the confidence threshold has not been calibrated against a production transaction sample. Database writes are retry-safe, but a crash between a link commit and its progress checkpoint can count that row as skipped on retry.

To use the feature, configure the Payee extraction AI feature, enable description matching and AI payee extraction in Payee Settings, then open **Optimizations → Resolve payees**. Select owned accounts and either selected rows or all unresolved rows in those accounts. New bank and file imports use the same fallback automatically while both settings are enabled. The feature is off by default.
