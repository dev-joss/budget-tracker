import {
  ACCOUNT_CATEGORIES,
  EXPENSIFY_MATCH_STATES,
  EXPENSIFY_REPORT_STATES,
  EXPENSIFY_REVIEW_REASONS,
  EXPENSIFY_SAFE_ERROR_CODES,
  TRANSACTION_TYPES,
  WORK_EXPENSE_SOURCES,
  type RecordId,
} from '@bt/shared/types';
import { afterAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { ERROR_CODES } from '@js/errors';
import * as helpers from '@tests/helpers';

import * as expensifyClient from './expensify/client';

const exportSpy = jest.spyOn(expensifyClient, 'exportExpensifyExpenses');
const TODAY = new Date().toISOString().slice(0, 10);
const TODAY_TIME = `${TODAY}T12:00:00.000Z`;
const CREDENTIALS = { partnerUserId: 'partner-user', partnerUserSecret: 'never-return-this-secret' };

function upstreamExpense({
  overrides = {},
}: {
  overrides?: Partial<expensifyClient.ExpensifyUpstreamExpense>;
} = {}): expensifyClient.ExpensifyUpstreamExpense {
  return {
    externalReportId: 'report-1',
    reportState: EXPENSIFY_REPORT_STATES.approved,
    externalExpenseId: 'expense-1',
    originalAmountCents: 1234,
    originalCurrencyCode: global.BASE_CURRENCY_CODE,
    expenseDate: TODAY,
    originalMerchant: 'Acme, Inc.',
    modifiedMerchant: null,
    isReimbursable: true,
    ...overrides,
  };
}

async function connectIntegration(_params: Record<string, never> = {}) {
  exportSpy.mockResolvedValueOnce([]);
  return helpers.updateWorkExpenseIntegration({ payload: CREDENTIALS, raw: true });
}

async function createExactScenario(_params: Record<string, never> = {}) {
  const account = await helpers.createAccount({
    payload: helpers.buildAccountPayload({ accountCategory: ACCOUNT_CATEGORIES.creditCard }),
    raw: true,
  });
  const [transaction] = await helpers.createTransaction({
    payload: {
      ...helpers.buildTransactionPayload({
        accountId: account.id,
        amount: 12.34,
        transactionType: TRANSACTION_TYPES.expense,
      }),
      note: 'ACME INC',
      time: TODAY_TIME,
    },
    raw: true,
  });
  exportSpy.mockResolvedValue([upstreamExpense()]);
  await helpers.triggerWorkExpenseSync({ raw: true });
  const status = await helpers.waitForWorkExpenseSync({
    predicate: (current) => current.status === 'completed',
  });
  expect(status).toMatchObject({ status: 'completed', importedCount: 1, matchedCount: 1 });
  const reconciliation = await helpers.getWorkExpenseReconciliation({ raw: true });
  expect(reconciliation.items).toHaveLength(1);
  return { transaction, item: reconciliation.items[0]! };
}

beforeEach(() => {
  exportSpy.mockReset().mockResolvedValue([]);
});

afterAll(() => {
  exportSpy.mockRestore();
});

describe('work-expense integration endpoints', () => {
  it('GET /integration returns a safe disconnected empty state', async () => {
    expect(await helpers.getWorkExpenseIntegration({ raw: true })).toEqual({
      connected: false,
      initialSyncDate: null,
      lastAttemptedSyncAt: null,
      lastSuccessfulSyncAt: null,
      lastErrorCode: null,
    });
  });

  it('PUT /integration validates and stores credentials without returning them', async () => {
    const state = await helpers.updateWorkExpenseIntegration({
      payload: { ...CREDENTIALS, initialSyncDate: '2025-01-01' },
      raw: true,
    });
    expect(state).toMatchObject({ connected: true, initialSyncDate: '2025-01-01' });
    expect(JSON.stringify(state)).not.toContain(CREDENTIALS.partnerUserId);
    expect(JSON.stringify(state)).not.toContain(CREDENTIALS.partnerUserSecret);
  });

  it('PUT /integration trims copied credential whitespace before validation', async () => {
    await helpers.updateWorkExpenseIntegration({
      payload: {
        partnerUserId: `  ${CREDENTIALS.partnerUserId}  `,
        partnerUserSecret: `  ${CREDENTIALS.partnerUserSecret}  `,
      },
      raw: true,
    });

    expect(exportSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        credentials: CREDENTIALS,
      }),
    );
  });

  it('PUT /integration rejects a whitespace-only secret before credential validation', async () => {
    const response = await helpers.updateWorkExpenseIntegration({
      payload: { partnerUserId: CREDENTIALS.partnerUserId, partnerUserSecret: '   ' },
    });

    expect(response.statusCode).toBe(ERROR_CODES.ValidationError);
    expect(exportSpy).not.toHaveBeenCalled();
  });

  it('PUT /integration rejects invalid credentials and preserves a working connection', async () => {
    await connectIntegration();
    exportSpy.mockRejectedValueOnce(
      new expensifyClient.ExpensifyClientError({ code: EXPENSIFY_SAFE_ERROR_CODES.authentication }),
    );
    const response = await helpers.updateWorkExpenseIntegration({
      payload: { partnerUserId: 'bad', partnerUserSecret: 'bad' },
    });
    expect(response.statusCode).toBe(ERROR_CODES.Unauthorized);
    expect(await helpers.getWorkExpenseIntegration({ raw: true })).toMatchObject({ connected: true });
  });

  it('PUT /integration rejects an impossible calendar date before credential validation', async () => {
    const response = await helpers.updateWorkExpenseIntegration({
      payload: { ...CREDENTIALS, initialSyncDate: '2026-02-30' },
    });
    expect(response.statusCode).toBe(ERROR_CODES.ValidationError);
    expect(exportSpy).not.toHaveBeenCalled();
  });

  it('DELETE /integration is idempotent and retains transaction classification', async () => {
    const [transaction] = await helpers.createTransaction({ raw: true });
    await helpers.setTransactionWorkExpense({ id: transaction.id, isWorkExpense: true, raw: true });
    await connectIntegration();
    expect(await helpers.disconnectWorkExpenseIntegration({ raw: true })).toMatchObject({ connected: false });
    expect(await helpers.disconnectWorkExpenseIntegration({ raw: true })).toMatchObject({ connected: false });
    const retained = await helpers.getTransactionById({ id: transaction.id, raw: true });
    expect(retained).toMatchObject({ isWorkExpense: true, workExpenseSource: WORK_EXPENSE_SOURCES.manual });
  });
});

describe('manual work-expense classification', () => {
  it('PATCH /transactions/:id/work-expense marks and explicitly unmarks a real expense', async () => {
    const [transaction] = await helpers.createTransaction({ raw: true });
    const marked = await helpers.setTransactionWorkExpense({ id: transaction.id, isWorkExpense: true, raw: true });
    expect(marked).toMatchObject({ isWorkExpense: true, workExpenseSource: WORK_EXPENSE_SOURCES.manual });
    const unmarked = await helpers.setTransactionWorkExpense({ id: transaction.id, isWorkExpense: false, raw: true });
    expect(unmarked).toMatchObject({ isWorkExpense: false, workExpenseSource: WORK_EXPENSE_SOURCES.manual });
  });

  it('keeps work metadata on normal transaction list and detail reads', async () => {
    const [transaction] = await helpers.createTransaction({ raw: true });
    await helpers.setTransactionWorkExpense({ id: transaction.id, isWorkExpense: true, raw: true });
    const list = await helpers.getTransactions({ limit: 30, raw: true });
    expect(list.find(({ id }) => id === transaction.id)).toMatchObject({
      isWorkExpense: true,
      workExpenseSource: WORK_EXPENSE_SOURCES.manual,
      workExpenseMatchState: null,
      workExpenseReviewReasons: [],
    });
  });

  it('rejects a planned transaction and malformed id', async () => {
    const account = await helpers.createAccount({ raw: true });
    const [planned] = await helpers.createPlannedTransaction({ payload: { accountId: account.id }, raw: true });
    expect((await helpers.setTransactionWorkExpense({ id: planned.id, isWorkExpense: true })).statusCode).toBe(
      ERROR_CODES.ValidationError,
    );
    expect(
      (await helpers.setTransactionWorkExpense({ id: 'bad-id' as RecordId, isWorkExpense: true })).statusCode,
    ).toBe(ERROR_CODES.ValidationError);
  });
});

describe('synchronization and reconciliation', () => {
  it('GET /sync/status and GET /reconciliation return empty states', async () => {
    expect(await helpers.getWorkExpenseSyncStatus({ raw: true })).toEqual({ status: 'idle' });
    expect(await helpers.getWorkExpenseReconciliation({ raw: true })).toEqual({
      items: [],
      total: 0,
      limit: 25,
      offset: 0,
    });
  });

  it('POST /sync imports an eligible expense idempotently and creates an exact candidate', async () => {
    await connectIntegration();
    const { transaction, item } = await createExactScenario();
    expect(item.expense).toMatchObject({ matchState: EXPENSIFY_MATCH_STATES.exact, originalAmount: 12.34 });
    expect(item.candidates[0]).toMatchObject({ transactionId: transaction.id, isReciprocalTop: true });

    await helpers.triggerWorkExpenseSync({ raw: true });
    await helpers.waitForWorkExpenseSync({ predicate: (status) => status.status === 'completed' });
    expect((await helpers.getWorkExpenseReconciliation({ raw: true })).total).toBe(1);
  });

  it('resets a disappeared unlinked suggestion to unmatched and removes its candidates', async () => {
    await connectIntegration();
    const { item } = await createExactScenario();
    expect(item.expense.matchState).toBe(EXPENSIFY_MATCH_STATES.exact);

    exportSpy.mockResolvedValue([]);
    await helpers.triggerWorkExpenseSync({ raw: true });
    await helpers.waitForWorkExpenseSync({ predicate: (status) => status.status === 'completed' });

    const reconciliation = await helpers.getWorkExpenseReconciliation({ raw: true });
    expect(reconciliation.items[0]).toMatchObject({
      expense: { matchState: EXPENSIFY_MATCH_STATES.unmatched },
      candidates: [],
    });
  });

  it('POST /sync rejects disconnected and concurrent runs with safe errors', async () => {
    expect((await helpers.triggerWorkExpenseSync()).statusCode).toBe(ERROR_CODES.ValidationError);
    await connectIntegration();
    let release!: () => void;
    const pending = new Promise<expensifyClient.ExpensifyUpstreamExpense[]>((resolve) => {
      release = () => resolve([]);
    });
    exportSpy.mockReturnValue(pending);
    await helpers.triggerWorkExpenseSync({ raw: true });
    await helpers.waitForWorkExpenseSync({ predicate: (status) => status.status === 'processing' });
    expect((await helpers.triggerWorkExpenseSync()).statusCode).toBe(ERROR_CODES.ConflictError);
    release();
    await helpers.waitForWorkExpenseSync({ predicate: (status) => status.status === 'completed' });
  });

  it('publishes only allowlisted failure codes and leaves a failed snapshot atomic', async () => {
    await connectIntegration();
    exportSpy.mockRejectedValue(
      new expensifyClient.ExpensifyClientError({ code: EXPENSIFY_SAFE_ERROR_CODES.invalidResponse }),
    );
    await helpers.triggerWorkExpenseSync({ raw: true });
    const status = await helpers.waitForWorkExpenseSync({ predicate: (current) => current.status === 'failed' });
    expect(status).toMatchObject({ errorCode: EXPENSIFY_SAFE_ERROR_CODES.invalidResponse });
    expect(JSON.stringify(status)).not.toMatch(/partner|secret|credential/i);
    expect((await helpers.getWorkExpenseReconciliation({ raw: true })).total).toBe(0);
  });

  it('GET /reconciliation validates state and paginates user-owned expenses', async () => {
    const invalid = await helpers.makeRequest({
      method: 'get',
      url: '/work-expenses/reconciliation',
      payload: { state: 'not-a-state' },
    });
    expect(invalid.statusCode).toBe(ERROR_CODES.ValidationError);
  });
});

describe('confirmation, unlink, deletion, and review lifecycle', () => {
  it('POST /matches/confirm classifies one exact match and rejects empty or stale choices', async () => {
    await connectIntegration();
    const { transaction, item } = await createExactScenario();
    expect((await helpers.confirmWorkExpenseMatches({ matches: [] })).statusCode).toBe(ERROR_CODES.ValidationError);
    expect(
      (
        await helpers.confirmWorkExpenseMatches({
          matches: [
            {
              expenseId: item.expense.id,
              transactionId: '01991963-d3bc-7d12-80a8-43adbeb57d65' as RecordId,
            },
          ],
        })
      ).statusCode,
    ).toBe(ERROR_CODES.ConflictError);

    expect(
      await helpers.confirmWorkExpenseMatches({
        matches: [{ expenseId: item.expense.id, transactionId: transaction.id }],
        raw: true,
      }),
    ).toEqual({ confirmedCount: 1 });
    expect(await helpers.getTransactionById({ id: transaction.id, raw: true })).toMatchObject({
      isWorkExpense: true,
      workExpenseSource: WORK_EXPENSE_SOURCES.expensify,
      workExpenseMatchState: EXPENSIFY_MATCH_STATES.exact,
    });
  });

  it('DELETE /matches/:expenseId removes the link without reversing classification', async () => {
    await connectIntegration();
    const { transaction, item } = await createExactScenario();
    await helpers.confirmWorkExpenseMatches({
      matches: [{ expenseId: item.expense.id, transactionId: transaction.id }],
      raw: true,
    });
    expect(await helpers.unlinkWorkExpenseMatch({ expenseId: item.expense.id, raw: true })).toEqual({
      expenseId: item.expense.id,
    });
    expect(await helpers.getTransactionById({ id: transaction.id, raw: true })).toMatchObject({
      isWorkExpense: true,
      workExpenseSource: WORK_EXPENSE_SOURCES.expensify,
    });
    expect((await helpers.unlinkWorkExpenseMatch({ expenseId: item.expense.id })).statusCode).toBe(
      ERROR_CODES.ConflictError,
    );
  });

  it('flags a materially edited linked transaction and resolves review by keeping it', async () => {
    await connectIntegration();
    const { transaction, item } = await createExactScenario();
    await helpers.confirmWorkExpenseMatches({
      matches: [{ expenseId: item.expense.id, transactionId: transaction.id }],
      raw: true,
    });
    await helpers.updateTransaction({ id: transaction.id, payload: { note: 'Different merchant' }, raw: true });
    const reviewed = await helpers.getWorkExpenseReconciliation({ state: EXPENSIFY_MATCH_STATES.review, raw: true });
    expect(reviewed.items[0]?.expense.reviewReasons).toContain(EXPENSIFY_REVIEW_REASONS.localTransactionChanged);
    const resolved = await helpers.resolveWorkExpenseReview({
      expenseId: item.expense.id,
      action: 'keep',
      raw: true,
    });
    expect(resolved?.expense.reviewReasons).toEqual([]);
  });

  it('keeps an acknowledged missing upstream expense resolved across later syncs', async () => {
    await connectIntegration();
    const { transaction, item } = await createExactScenario();
    await helpers.confirmWorkExpenseMatches({
      matches: [{ expenseId: item.expense.id, transactionId: transaction.id }],
      raw: true,
    });

    exportSpy.mockResolvedValue([]);
    await helpers.triggerWorkExpenseSync({ raw: true });
    await helpers.waitForWorkExpenseSync({ predicate: (status) => status.status === 'completed' });
    const reviewed = await helpers.getWorkExpenseReconciliation({ state: EXPENSIFY_MATCH_STATES.review, raw: true });
    expect(reviewed.items[0]?.expense.reviewReasons).toContain(EXPENSIFY_REVIEW_REASONS.upstreamMissing);
    await helpers.resolveWorkExpenseReview({ expenseId: item.expense.id, action: 'keep', raw: true });

    await helpers.triggerWorkExpenseSync({ raw: true });
    await helpers.waitForWorkExpenseSync({ predicate: (status) => status.status === 'completed' });
    expect(
      (await helpers.getWorkExpenseReconciliation({ state: EXPENSIFY_MATCH_STATES.review, raw: true })).items,
    ).toHaveLength(0);
  });

  it('keeps an acknowledged ineligible upstream expense resolved until its fingerprint changes', async () => {
    await connectIntegration();
    const { transaction, item } = await createExactScenario();
    await helpers.confirmWorkExpenseMatches({
      matches: [{ expenseId: item.expense.id, transactionId: transaction.id }],
      raw: true,
    });

    exportSpy.mockResolvedValue([upstreamExpense({ overrides: { isReimbursable: false } })]);
    await helpers.triggerWorkExpenseSync({ raw: true });
    await helpers.waitForWorkExpenseSync({ predicate: (status) => status.status === 'completed' });
    const reviewed = await helpers.getWorkExpenseReconciliation({ state: EXPENSIFY_MATCH_STATES.review, raw: true });
    expect(reviewed.items[0]?.expense.reviewReasons).toContain(EXPENSIFY_REVIEW_REASONS.upstreamIneligible);
    await helpers.resolveWorkExpenseReview({ expenseId: item.expense.id, action: 'keep', raw: true });

    await helpers.triggerWorkExpenseSync({ raw: true });
    await helpers.waitForWorkExpenseSync({ predicate: (status) => status.status === 'completed' });
    expect(
      (await helpers.getWorkExpenseReconciliation({ state: EXPENSIFY_MATCH_STATES.review, raw: true })).items,
    ).toHaveLength(0);
  });

  it('marks a deleted linked transaction for review while retaining the imported expense', async () => {
    await connectIntegration();
    const { transaction, item } = await createExactScenario();
    await helpers.confirmWorkExpenseMatches({
      matches: [{ expenseId: item.expense.id, transactionId: transaction.id }],
      raw: true,
    });
    expect((await helpers.deleteTransaction({ id: transaction.id })).statusCode).toBe(200);
    const reviewed = await helpers.getWorkExpenseReconciliation({ state: EXPENSIFY_MATCH_STATES.review, raw: true });
    expect(reviewed.items[0]?.expense).toMatchObject({ linkedTransactionId: null });
    expect(reviewed.items[0]?.expense.reviewReasons).toContain(EXPENSIFY_REVIEW_REASONS.transactionDeleted);
  });

  it('rebuilds review candidates after the linked transaction is deleted', async () => {
    await connectIntegration();
    const { transaction, item } = await createExactScenario();
    await helpers.confirmWorkExpenseMatches({
      matches: [{ expenseId: item.expense.id, transactionId: transaction.id }],
      raw: true,
    });
    const account = await helpers.createAccount({
      payload: helpers.buildAccountPayload({ accountCategory: ACCOUNT_CATEGORIES.creditCard }),
      raw: true,
    });
    const [replacement] = await helpers.createTransaction({
      payload: {
        ...helpers.buildTransactionPayload({
          accountId: account.id,
          amount: 12.34,
          transactionType: TRANSACTION_TYPES.expense,
        }),
        note: 'ACME INC',
        time: TODAY_TIME,
      },
      raw: true,
    });

    await helpers.deleteTransaction({ id: transaction.id });
    await helpers.triggerWorkExpenseSync({ raw: true });
    await helpers.waitForWorkExpenseSync({ predicate: (status) => status.status === 'completed' });
    const reviewed = await helpers.getWorkExpenseReconciliation({ state: EXPENSIFY_MATCH_STATES.review, raw: true });
    expect(reviewed.items[0]?.candidates).toEqual(
      expect.arrayContaining([expect.objectContaining({ transactionId: replacement.id })]),
    );

    const relinked = await helpers.resolveWorkExpenseReview({
      expenseId: item.expense.id,
      action: 'relink',
      transactionId: replacement.id,
      raw: true,
    });
    expect(relinked?.expense).toMatchObject({ linkedTransactionId: replacement.id, reviewReasons: [] });
  });

  it('POST /reviews/:expenseId/resolve validates its action-specific payload', async () => {
    const response = await helpers.makeRequest({
      method: 'post',
      url: '/work-expenses/reviews/01991963-d3bc-7d12-80a8-43adbeb57d65/resolve',
      payload: { action: 'relink' },
    });
    expect(response.statusCode).toBe(ERROR_CODES.ValidationError);
  });
});
