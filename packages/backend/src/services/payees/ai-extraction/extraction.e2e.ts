import {
  AI_FEATURE,
  BANK_PROVIDER_TYPE,
  AccountOptionValue,
  CategoryOptionValue,
  CurrencyOptionValue,
  TransactionTypeOptionValue,
  type PayeeExtractionStatus,
  type RecordId,
} from '@bt/shared/types';
import { until } from '@common/helpers';
import { generateRandomRecordId } from '@common/lib/record-id-helpers';
import { describe, expect, it } from '@jest/globals';
import * as helpers from '@tests/helpers';
import { useSelfHostWithoutServerAiKeys } from '@tests/helpers/ai-test-env';
import { GEMINI_API_URL, VALID_GEMINI_API_KEY } from '@tests/mocks/gemini/mock-api';
import { CUSTOM_ENDPOINT_BASE_URL, CUSTOM_ENDPOINT_MODEL } from '@tests/mocks/openai-compatible/mock-api';
import { HttpResponse, http } from 'msw';

const AMAZON_DESCRIPTIONS = ['AMAZON MKTPL*1X9E14O63', 'Amazon.com*MB2YO3V43'];

async function seedImportedRows({
  descriptions,
  preserveConsent = false,
}: {
  descriptions: string[];
  preserveConsent?: boolean;
}) {
  if (!preserveConsent) {
    await helpers.patchUserSettings({
      patch: { payeeExtractionUsesDescription: false, payeeAiExtractionEnabled: false },
      raw: true,
    });
  }
  const account = await helpers.createAccount({ raw: true });
  const user = await helpers.getUserInfo({ raw: true });
  const { jobId } = await helpers.executeImport({
    payload: {
      fileContent: [
        'Date,Amount,Description,Payee,Currency',
        ...descriptions.map((description, index) =>
          ['2024-01-15', -(20 + index), description, '', account.currencyCode].join(','),
        ),
      ].join('\n'),
      delimiter: ',',
      columnMapping: {
        date: 'Date',
        dateFieldOrder: 'month-first',
        amount: 'Amount',
        description: 'Description',
        payee: 'Payee',
        category: { option: CategoryOptionValue.existingCategory, categoryId: user.defaultCategoryId! },
        account: { option: AccountOptionValue.existingAccount, accountId: account.id },
        currency: { option: CurrencyOptionValue.dataSourceColumn, columnName: 'Currency' },
        transactionType: { option: TransactionTypeOptionValue.amountSign },
      },
      accountMapping: {},
      categoryMapping: {},
      skipDuplicateIndices: [],
    },
    raw: true,
  });
  const progress = await helpers.waitForCsvImportCompletion({ jobId });
  helpers.expectCsvImportCompleted(progress);
  expect(progress.summary.imported).toBe(descriptions.length);
  return { account, ids: progress.summary.newTransactionIds as RecordId[] };
}

async function enableExtraction() {
  const endpoint = await helpers.createAiCustomEndpoint({
    name: 'Private extraction',
    baseUrl: CUSTOM_ENDPOINT_BASE_URL,
    defaultModel: CUSTOM_ENDPOINT_MODEL,
    raw: true,
  });
  await helpers.setAiFeatureConfig({
    feature: AI_FEATURE.payeeExtraction,
    modelId: `custom/${CUSTOM_ENDPOINT_MODEL}`,
    customEndpointId: endpoint.id,
    raw: true,
  });
  await helpers.patchUserSettings({
    patch: { payeeExtractionUsesDescription: true, payeeAiExtractionEnabled: true },
    raw: true,
  });
}

interface SourceInput {
  id: string;
  sourceDescription: string;
}

function mockExtraction({
  confidence = 0.99,
  invalid = false,
  beforeResponse,
}: {
  confidence?: number;
  invalid?: boolean;
  beforeResponse?: () => Promise<void>;
} = {}) {
  const requests: SourceInput[][] = [];
  global.mswMockServer.use(
    http.post(`${CUSTOM_ENDPOINT_BASE_URL}/chat/completions`, async ({ request }) => {
      const body = (await request.json()) as { model: string; messages: Array<{ role: string; content: string }> };
      const prompt = body.messages.find((message) => message.role === 'user')!.content;
      const { descriptions } = JSON.parse(prompt) as { descriptions: SourceInput[] };
      requests.push(descriptions);
      await beforeResponse?.();
      const content = invalid
        ? '{"results":'
        : JSON.stringify({
            results: descriptions.map((input) => ({ ...input, normalizedPayeeName: 'Amazon', confidence })),
          });
      return HttpResponse.json({
        id: 'chatcmpl-payee-extraction',
        object: 'chat.completion',
        created: 1700000000,
        model: body.model,
        choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 100, completion_tokens: 60, total_tokens: 160 },
      });
    }),
  );
  return requests;
}

async function triggerAndWait({ transactionIds }: { transactionIds?: string[] } = {}) {
  const trigger = await helpers.triggerPayeeExtraction({ payload: { transactionIds }, raw: true });
  expect(trigger.enqueued).toBe(true);
  expect(trigger.runId).toEqual(expect.any(String));
  const status = await helpers.waitForPayeeExtraction({ runId: trigger.runId! });
  expect(status.scanned).toBe(status.linked + status.skipped + status.lowConfidence + status.failed);
  return status;
}

async function waitForAutomaticExtraction() {
  let runId: string | null = null;
  await until(
    async () => {
      runId = (await helpers.getPayeeExtractionStatus({ raw: true })).runId;
      return runId !== null;
    },
    { timeout: 10000, interval: 100 },
  );
  expect(runId).toEqual(expect.any(String));
  return helpers.waitForPayeeExtraction({ runId: runId! });
}

async function pauseExtractionResponse() {
  let release!: () => void;
  let started!: () => void;
  const responseGate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const requestStarted = new Promise<void>((resolve) => {
    started = resolve;
  });
  mockExtraction({
    beforeResponse: async () => {
      started();
      await responseGate;
    },
  });
  const trigger = await helpers.triggerPayeeExtraction({ raw: true });
  expect(trigger.enqueued).toBe(true);
  await requestStarted;
  return { runId: trigger.runId!, release };
}

function expectCounts({ status, linked }: { status: PayeeExtractionStatus; linked: number }) {
  expect(status.status).toBe('completed');
  expect(status.linked).toBe(linked);
}

describe('Payee extraction HTTP API', () => {
  useSelfHostWithoutServerAiKeys();

  it('lists unresolved imported rows and paginates within owned accounts', async () => {
    const { account, ids } = await seedImportedRows({ descriptions: AMAZON_DESCRIPTIONS });
    await helpers.createTransaction({
      payload: helpers.buildTransactionPayload({ accountId: account.id, note: 'Manual ledger row' }),
      raw: true,
    });
    const first = await helpers.getPayeeExtractionCandidates({
      payload: { accountIds: [account.id], limit: 1 },
      raw: true,
    });
    const second = await helpers.getPayeeExtractionCandidates({
      payload: { accountIds: [account.id], limit: 1, offset: 1 },
      raw: true,
    });
    expect(first.totalCount).toBe(2);
    expect(first.items).toHaveLength(1);
    expect(second.items).toHaveLength(1);
    expect(new Set([...first.items, ...second.items].map((row) => row.id))).toEqual(new Set(ids));
  });

  it('returns an empty list and idle status before a run exists', async () => {
    expect(await helpers.getPayeeExtractionCandidates({ raw: true })).toEqual({ items: [], totalCount: 0 });
    expect(await helpers.getPayeeExtractionStatus({ raw: true })).toMatchObject({ status: 'idle', runId: null });
  });

  it('rejects invalid pagination, empty selected IDs, and unknown run IDs', async () => {
    expect((await helpers.getPayeeExtractionCandidates({ payload: { limit: 0 } })).statusCode).toBe(422);
    expect((await helpers.triggerPayeeExtraction({ payload: { transactionIds: [] } })).statusCode).toBe(422);
    expect((await helpers.getPayeeExtractionStatus({ runId: `payee-${generateRandomRecordId()}` })).statusCode).toBe(
      404,
    );
  });

  it('requires extraction consent and a configured AI destination', async () => {
    await seedImportedRows({ descriptions: [AMAZON_DESCRIPTIONS[0]!] });
    expect((await helpers.triggerPayeeExtraction()).statusCode).toBe(422);
    await helpers.patchUserSettings({
      patch: { payeeExtractionUsesDescription: true, payeeAiExtractionEnabled: true },
      raw: true,
    });
    expect((await helpers.triggerPayeeExtraction()).statusCode).toBe(422);
  });

  it('does not enqueue an empty scope after configuration', async () => {
    await enableExtraction();
    expect(await helpers.triggerPayeeExtraction({ raw: true })).toMatchObject({
      enqueued: false,
      totalCount: 0,
      runId: null,
    });
  });

  it('links distinct Amazon descriptions to one payee and leaves no work on repeat', async () => {
    const { ids } = await seedImportedRows({ descriptions: AMAZON_DESCRIPTIONS });
    await enableExtraction();
    const requests = mockExtraction();
    expectCounts({ status: await triggerAndWait(), linked: 2 });
    const rows = await helpers.getTransactionsByIds({ ids, raw: true });
    expect(new Set(rows.map((row) => row.payeeId)).size).toBe(1);
    expect(rows[0]!.payeeId).toEqual(expect.any(String));
    expect((await helpers.listPayees({ raw: true })).map((payee) => payee.name)).toEqual(['Amazon']);
    expect(await helpers.triggerPayeeExtraction({ raw: true })).toMatchObject({ enqueued: false, totalCount: 0 });
    expect(requests).toHaveLength(1);
    expect(requests[0]!.every((input) => Object.keys(input).toSorted().join(',') === 'id,sourceDescription')).toBe(
      true,
    );
  });

  it('leaves low-confidence output unresolved without creating a payee', async () => {
    const { ids } = await seedImportedRows({ descriptions: [AMAZON_DESCRIPTIONS[0]!] });
    await enableExtraction();
    mockExtraction({ confidence: 0.94 });
    const status = await triggerAndWait();
    expect(status).toMatchObject({ linked: 0, lowConfidence: 1 });
    expect((await helpers.getTransactionsByIds({ ids, raw: true }))[0]!.payeeId).toBeNull();
    expect(await helpers.listPayees({ raw: true })).toEqual([]);
  });

  it('rejects malformed output and keeps source text out of status errors', async () => {
    await seedImportedRows({ descriptions: [AMAZON_DESCRIPTIONS[0]!] });
    await enableExtraction();
    mockExtraction({ invalid: true });
    const status = await triggerAndWait();
    expect(status.linked).toBe(0);
    expect(status.failed).toBe(1);
    expect(JSON.stringify(status)).not.toContain(AMAZON_DESCRIPTIONS[0]);
    expect(await helpers.listPayees({ raw: true })).toEqual([]);
  });

  it('excludes manually linked and manually cleared locked rows', async () => {
    const { ids } = await seedImportedRows({ descriptions: AMAZON_DESCRIPTIONS });
    const payee = await helpers.createPayee({ payload: { name: 'User merchant' }, raw: true });
    await helpers.updateTransaction({ id: ids[0]!, payload: { payeeId: payee.id }, raw: true });
    await helpers.updateTransaction({ id: ids[1]!, payload: { payeeId: null, payeeLocked: true }, raw: true });
    expect(await helpers.getPayeeExtractionCandidates({ raw: true })).toEqual({ items: [], totalCount: 0 });
  });

  it('limits the run to selected transactions', async () => {
    const { ids } = await seedImportedRows({ descriptions: AMAZON_DESCRIPTIONS });
    await enableExtraction();
    mockExtraction();
    expectCounts({ status: await triggerAndWait({ transactionIds: [ids[0]!] }), linked: 1 });
    const rows = await helpers.getTransactionsByIds({ ids, raw: true });
    expect(rows.find((row) => row.id === ids[0])!.payeeId).toEqual(expect.any(String));
    expect(rows.find((row) => row.id === ids[1])!.payeeId).toBeNull();
  });

  it('rejects foreign account scopes and hides another owner run', async () => {
    await seedImportedRows({ descriptions: [AMAZON_DESCRIPTIONS[0]!] });
    await enableExtraction();
    mockExtraction({ confidence: 0.5 });
    const status = await triggerAndWait();
    const otherUser = await helpers.provisionSecondUserWithBaseCurrency();
    const foreignAccount = await helpers.asUser({
      cookies: otherUser.cookies,
      fn: () => helpers.createAccount({ raw: true }),
    });
    expect(
      (await helpers.getPayeeExtractionCandidates({ payload: { accountIds: [foreignAccount.id] } })).statusCode,
    ).toBe(404);
    expect((await helpers.triggerPayeeExtraction({ payload: { accountIds: [foreignAccount.id] } })).statusCode).toBe(
      404,
    );
    const foreignStatus = await helpers.asUser({
      cookies: otherUser.cookies,
      fn: () => helpers.getPayeeExtractionStatus({ runId: status.runId! }),
    });
    expect(foreignStatus.statusCode).toBe(404);
  });

  it('preserves a manual payee assignment while the model request is pending', async () => {
    const { ids } = await seedImportedRows({ descriptions: [AMAZON_DESCRIPTIONS[0]!] });
    const manual = await helpers.createPayee({ payload: { name: 'Local bookshop' }, raw: true });
    await enableExtraction();
    let release!: () => void;
    let started!: () => void;
    const responseGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const requestStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    mockExtraction({
      beforeResponse: async () => {
        started();
        await responseGate;
      },
    });
    const trigger = await helpers.triggerPayeeExtraction({ raw: true });
    try {
      await requestStarted;
      await helpers.updateTransaction({ id: ids[0]!, payload: { payeeId: manual.id }, raw: true });
    } finally {
      release();
    }
    const status = await helpers.waitForPayeeExtraction({ runId: trigger.runId! });
    expect(status.linked).toBe(0);
    expect((await helpers.getTransactionsByIds({ ids, raw: true }))[0]!.payeeId).toBe(manual.id);
    expect((await helpers.listPayees({ raw: true })).map((payee) => payee.name)).toEqual(['Local bookshop']);
  });

  it.each(['payeeAiExtractionEnabled', 'payeeExtractionUsesDescription'])(
    'does not apply a response after %s consent is revoked',
    async (setting) => {
      const { ids } = await seedImportedRows({ descriptions: [AMAZON_DESCRIPTIONS[0]!] });
      await enableExtraction();
      const pending = await pauseExtractionResponse();
      try {
        await helpers.patchUserSettings({ patch: { [setting]: false }, raw: true });
      } finally {
        pending.release();
      }
      const status = await helpers.waitForPayeeExtraction({ runId: pending.runId });
      expect(status.linked).toBe(0);
      expect((await helpers.getTransactionsByIds({ ids, raw: true }))[0]!.payeeId).toBeNull();
      expect(await helpers.listPayees({ raw: true })).toEqual([]);
    },
  );

  it('preserves a locked manual clear while the model request is pending', async () => {
    const { ids } = await seedImportedRows({ descriptions: [AMAZON_DESCRIPTIONS[0]!] });
    await enableExtraction();
    const pending = await pauseExtractionResponse();
    try {
      await helpers.updateTransaction({ id: ids[0]!, payload: { payeeId: null, payeeLocked: true }, raw: true });
    } finally {
      pending.release();
    }
    const status = await helpers.waitForPayeeExtraction({ runId: pending.runId });
    expect(status.linked).toBe(0);
    const [row] = await helpers.getTransactionsByIds({ ids, raw: true });
    expect(row).toMatchObject({ payeeId: null, payeeLocked: true });
    expect(await helpers.listPayees({ raw: true })).toEqual([]);
  });

  it('does not apply a mapping after its source note changes during the request', async () => {
    const { ids } = await seedImportedRows({ descriptions: [AMAZON_DESCRIPTIONS[0]!] });
    await enableExtraction();
    const pending = await pauseExtractionResponse();
    try {
      await helpers.updateTransaction({ id: ids[0]!, payload: { note: 'Corrected source description' }, raw: true });
    } finally {
      pending.release();
    }
    const status = await helpers.waitForPayeeExtraction({ runId: pending.runId });
    expect(status.linked).toBe(0);
    expect((await helpers.getTransactionsByIds({ ids, raw: true }))[0]!.payeeId).toBeNull();
    expect(await helpers.listPayees({ raw: true })).toEqual([]);
  });

  it('rejects a second explicit trigger while the first model request is pending', async () => {
    await seedImportedRows({ descriptions: [AMAZON_DESCRIPTIONS[0]!] });
    await enableExtraction();
    const pending = await pauseExtractionResponse();
    try {
      expect((await helpers.triggerPayeeExtraction()).statusCode).toBe(409);
    } finally {
      pending.release();
    }
    expectCounts({ status: await helpers.waitForPayeeExtraction({ runId: pending.runId }), linked: 1 });
  });

  it.each([
    { label: 'source', rawName: AMAZON_DESCRIPTIONS[0]! },
    { label: 'target', rawName: 'Amazon' },
  ])('does not link an ignored $label', async ({ rawName }) => {
    const { ids } = await seedImportedRows({ descriptions: [AMAZON_DESCRIPTIONS[0]!] });
    await helpers.addIgnoredName({ rawName, raw: true });
    await enableExtraction();
    mockExtraction();
    expect((await triggerAndWait()).linked).toBe(0);
    expect((await helpers.getTransactionsByIds({ ids, raw: true }))[0]!.payeeId).toBeNull();
    expect(await helpers.listPayees({ raw: true })).toEqual([]);
  });

  it('does not send a private endpoint failure to a cloud provider', async () => {
    await seedImportedRows({ descriptions: [AMAZON_DESCRIPTIONS[0]!] });
    await enableExtraction();
    process.env.GEMINI_API_KEY = VALID_GEMINI_API_KEY;
    let cloudRequests = 0;
    global.mswMockServer.use(
      http.post(GEMINI_API_URL, () => {
        cloudRequests += 1;
        return HttpResponse.json({});
      }),
    );
    global.mswMockServer.use(
      http.post(`${CUSTOM_ENDPOINT_BASE_URL}/chat/completions`, () =>
        HttpResponse.json({ error: { message: 'Private source text must not escape' } }, { status: 401 }),
      ),
    );
    const status = await triggerAndWait();
    expect(status.linked).toBe(0);
    expect(status.status).toBe('failed');
    expect(JSON.stringify(status)).not.toContain('Private source text');
    expect(cloudRequests).toBe(0);
    expect(await helpers.listPayees({ raw: true })).toEqual([]);
  });

  it('automatically resolves the issue Amazon descriptions from Plaid with no merchant_name', async () => {
    const envKeys = ['PLAID_CLIENT_ID', 'PLAID_SECRET', 'PLAID_ENV'] as const;
    const originalEnv = new Map(envKeys.map((key) => [key, process.env[key]]));
    process.env.PLAID_CLIENT_ID = 'client-id';
    process.env.PLAID_SECRET = 'secret';
    process.env.PLAID_ENV = 'sandbox';
    try {
      await enableExtraction();
      const requests = mockExtraction();
      const plaidAccountId = 'extraction-plaid-account';
      const account = {
        account_id: plaidAccountId,
        balances: {
          available: 1000,
          current: 1000,
          iso_currency_code: 'AED',
          limit: null,
          unofficial_currency_code: null,
        },
        mask: '1234',
        name: 'Checking',
        official_name: 'Checking',
        persistent_account_id: 'persistent-extraction',
        subtype: 'checking',
        type: 'depository',
        verification_status: null,
      };
      global.mswMockServer.use(
        http.post('https://sandbox.plaid.com/item/public_token/exchange', () =>
          HttpResponse.json({ access_token: 'access-token', item_id: 'extraction-item', request_id: 'request-1' }),
        ),
        http.post('https://sandbox.plaid.com/item/get', () =>
          HttpResponse.json({
            item: {
              available_products: [],
              billed_products: ['transactions'],
              consent_expiration_time: null,
              error: null,
              institution_id: 'institution-1',
              item_id: 'extraction-item',
              products: ['transactions'],
              update_type: 'background',
              webhook: '',
            },
            request_id: 'request-2',
            status: null,
          }),
        ),
        http.post('https://sandbox.plaid.com/institutions/get_by_id', () =>
          HttpResponse.json({
            institution: { institution_id: 'institution-1', name: 'Test Bank' },
            request_id: 'request-3',
          }),
        ),
        http.post('https://sandbox.plaid.com/accounts/get', () =>
          HttpResponse.json({ accounts: [account], item: { item_id: 'extraction-item' }, request_id: 'request-4' }),
        ),
        http.post('https://sandbox.plaid.com/transactions/sync', () =>
          HttpResponse.json({
            added: AMAZON_DESCRIPTIONS.map((name, index) => ({
              account_id: plaidAccountId,
              account_owner: null,
              amount: 12.34 + index,
              authorized_date: '2026-08-30',
              authorized_datetime: null,
              date: '2026-08-30',
              datetime: null,
              iso_currency_code: 'AED',
              location: {},
              merchant_name: null,
              name,
              payment_channel: 'online',
              payment_meta: {},
              pending: false,
              pending_transaction_id: null,
              transaction_code: null,
              transaction_id: `extraction-plaid-transaction-${index}`,
              unofficial_currency_code: null,
            })),
            has_more: false,
            modified: [],
            next_cursor: 'extraction-cursor',
            removed: [],
            request_id: 'request-5',
            transactions_update_status: 'HISTORICAL_UPDATE_COMPLETE',
          }),
        ),
      );
      const { connectionId } = await helpers.bankDataProviders.connectProvider({
        providerType: BANK_PROVIDER_TYPE.PLAID,
        credentials: { publicToken: 'public-token' },
        raw: true,
      });
      const { syncedAccounts } = await helpers.bankDataProviders.connectSelectedAccounts({
        connectionId,
        accountExternalIds: [plaidAccountId],
        raw: true,
      });
      const accountId = syncedAccounts[0]!.id;
      await until(
        async () => {
          const rows = await helpers.getTransactions({ accountIds: [accountId], raw: true });
          return rows.length === 2 && rows.every((row) => row.payeeId !== null);
        },
        { timeout: 10000, interval: 100 },
      );
      const rows = await helpers.getTransactions({ accountIds: [accountId], raw: true });
      expect(new Set(rows.map((row) => row.payeeId)).size).toBe(1);
      expect((await helpers.listPayees({ raw: true })).map((payee) => payee.name)).toEqual(['Amazon']);
      expect(
        requests
          .flat()
          .map((input) => input.sourceDescription)
          .toSorted(),
      ).toEqual(AMAZON_DESCRIPTIONS.toSorted());
    } finally {
      for (const key of envKeys) {
        const value = originalEnv.get(key);
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it('automatically resolves unresolved CSV rows after a successful import', async () => {
    await enableExtraction();
    const requests = mockExtraction();
    const { ids } = await seedImportedRows({
      descriptions: AMAZON_DESCRIPTIONS,
      preserveConsent: true,
    });
    const status = await waitForAutomaticExtraction();
    expectCounts({ status, linked: 2 });
    const rows = await helpers.getTransactionsByIds({ ids, raw: true });
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.payeeId !== null)).toBe(true);
    expect(new Set(rows.map((row) => row.payeeId)).size).toBe(1);
    expect(requests.flat()).toHaveLength(2);
  });

  it('keeps an automatic CSV import successful when the model endpoint fails', async () => {
    await enableExtraction();
    let modelRequests = 0;
    global.mswMockServer.use(
      http.post(`${CUSTOM_ENDPOINT_BASE_URL}/chat/completions`, () => {
        modelRequests += 1;
        return HttpResponse.json({ error: { message: 'Endpoint unavailable' } }, { status: 503 });
      }),
    );
    const { ids } = await seedImportedRows({
      descriptions: [AMAZON_DESCRIPTIONS[0]!],
      preserveConsent: true,
    });
    const status = await waitForAutomaticExtraction();
    expect(status).toMatchObject({ status: 'failed', linked: 0 });
    expect(modelRequests).toBeGreaterThan(0);
    const rows = await helpers.getTransactionsByIds({ ids, raw: true });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.payeeId).toBeNull();
    expect((await helpers.getPayeeExtractionCandidates({ raw: true })).totalCount).toBe(1);
  });

  it('continues past two hundred rows with bounded model requests and complete counts', async () => {
    const descriptions = Array.from({ length: 201 }, (_, index) => `Unidentified charge reference ${index}`);
    await seedImportedRows({ descriptions });
    await enableExtraction();
    const requests = mockExtraction({ confidence: 0.5 });
    const status = await triggerAndWait();
    expect(status).toMatchObject({ scanned: 201, linked: 0, lowConfidence: 201 });
    expect(requests.length).toBeGreaterThanOrEqual(5);
    expect(requests.every((inputs) => inputs.length <= 50)).toBe(true);
    expect(requests.flat()).toHaveLength(201);
    expect(new Set(requests.flat().map((input) => input.sourceDescription)).size).toBe(201);
  });
});
