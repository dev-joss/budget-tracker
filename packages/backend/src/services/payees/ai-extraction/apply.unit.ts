import PayeeIgnoredNames from '@models/payee-ignored-names.model';
import { findTransactions, updateTransactions } from '@models/transactions-query';
import { createAIClient } from '@services/ai';
import { getUserSettings } from '@services/user-settings/get-user-settings';

import { applyPayeeCategorization } from '../apply-categorization';
import { resolveNormalizedName } from '../payee-namespace';
import { createPayee } from '../payees.service';
import { applyExtractedPayee, extractionDestination, resolveStoredPayee, snapshotForExtraction } from './apply';

jest.mock('@models/payee-aliases.model', () => ({ __esModule: true, default: {} }));
jest.mock('@models/payee-ignored-names.model', () => ({
  __esModule: true,
  default: { findOne: jest.fn(), findAll: jest.fn() },
}));
jest.mock('@models/payees.model', () => ({ __esModule: true, default: { findAll: jest.fn().mockResolvedValue([]) } }));
jest.mock('@models/transactions-query', () => ({ findTransactions: jest.fn(), updateTransactions: jest.fn() }));
jest.mock('@services/ai', () => ({ createAIClient: jest.fn() }));
jest.mock('@services/common/with-transaction', () => ({ withTransaction: (callback: unknown) => callback }));
jest.mock('@services/user-settings/get-user-settings', () => ({ getUserSettings: jest.fn() }));
jest.mock('../apply-categorization', () => ({ applyPayeeCategorization: jest.fn() }));
jest.mock('../apply-default-tags', () => ({ applyPayeeDefaultTags: jest.fn() }));
jest.mock('../extraction.service', () => ({
  extractRawFromTransaction: ({ externalData }: { externalData?: { merchant?: string } }) =>
    externalData?.merchant ?? '',
}));
jest.mock('../fuzzy-matcher', () => ({ buildHaystack: jest.fn(), fuzzyFindBestMatch: jest.fn() }));
jest.mock('../payee-namespace', () => ({
  ensureAliasExists: jest.fn(),
  lockPayeeNamespace: jest.fn(),
  resolveNormalizedName: jest.fn(),
}));
jest.mock('../payees.service', () => ({ createPayee: jest.fn() }));
jest.mock('./candidates', () => ({ extractionPolicy: jest.fn(), extractionWhere: jest.fn() }));

const row = { id: 'row', accountId: 'account', note: 'source', externalData: { merchant: 'Café' } };
const snapshot = snapshotForExtraction({ row: row as never });

beforeEach(() => {
  jest.clearAllMocks();
  jest
    .mocked(getUserSettings)
    .mockResolvedValue({ payeeAiExtractionEnabled: true, payeeExtractionUsesDescription: true } as never);
  jest.mocked(findTransactions).mockResolvedValue([row] as never);
  jest.mocked(updateTransactions).mockResolvedValue([1] as never);
  jest.mocked(PayeeIgnoredNames.findOne).mockResolvedValue(null);
  jest.mocked(PayeeIgnoredNames.findAll).mockResolvedValue([]);
  jest.mocked(resolveNormalizedName).mockResolvedValue(null);
  jest.mocked(createPayee).mockResolvedValue({ id: 'payee' } as never);
});

it('rechecks consent before deterministic description processing', async () => {
  jest
    .mocked(getUserSettings)
    .mockResolvedValue({ payeeAiExtractionEnabled: true, payeeExtractionUsesDescription: false } as never);
  expect(await resolveStoredPayee({ userId: 1, snapshot, repeatedSources: new Set() })).toBe('skipped');
  expect(findTransactions).not.toHaveBeenCalled();
});

it('rejects a row moved to another owned account', async () => {
  jest.mocked(findTransactions).mockResolvedValue([{ ...row, accountId: 'other-account' }] as never);
  expect(await resolveStoredPayee({ userId: 1, snapshot, repeatedSources: new Set() })).toBe('skipped');
  expect(updateTransactions).not.toHaveBeenCalled();
});

it('does not count a guarded zero-row update as a link or apply related rules', async () => {
  jest.mocked(resolveNormalizedName).mockResolvedValue({ payeeId: 'payee' } as never);
  jest.mocked(updateTransactions).mockResolvedValue([0] as never);
  expect(await resolveStoredPayee({ userId: 1, snapshot, repeatedSources: new Set() })).toBe('skipped');
  expect(applyPayeeCategorization).not.toHaveBeenCalled();
});

it('skips ignored unresolved sources while preserving exact user mappings', async () => {
  jest.mocked(PayeeIgnoredNames.findOne).mockResolvedValue({ id: 'ignored' } as never);
  expect(await resolveStoredPayee({ userId: 1, snapshot, repeatedSources: new Set() })).toBe('skipped');
  expect(updateTransactions).not.toHaveBeenCalled();

  jest.mocked(resolveNormalizedName).mockResolvedValue({ payeeId: 'payee' } as never);
  expect(await resolveStoredPayee({ userId: 1, snapshot, repeatedSources: new Set() })).toBe('linked');
});

it('promotes only a normalized source present in the shared repeated-source evidence', async () => {
  expect(await resolveStoredPayee({ userId: 1, snapshot, repeatedSources: new Set() })).toBe('unresolved');
  expect(createPayee).not.toHaveBeenCalled();

  expect(await resolveStoredPayee({ userId: 1, snapshot, repeatedSources: new Set(['cafe']) })).toBe('linked');
  expect(createPayee).toHaveBeenCalledWith({ userId: 1, name: 'Café' });
});

it('rejects a merchant ignored while the model request was in flight without creating a payee', async () => {
  const client = { provider: 'openai', modelId: 'openai/model', usingUserKey: true };
  jest.mocked(createAIClient).mockResolvedValue(client as never);
  jest.mocked(PayeeIgnoredNames.findAll).mockResolvedValue([{ normalizedName: 'cafe' }] as never);

  expect(
    await applyExtractedPayee({
      userId: 1,
      snapshots: [snapshot],
      name: 'Target',
      destination: extractionDestination({ client }),
    }),
  ).toEqual([]);
  expect(createPayee).not.toHaveBeenCalled();
  expect(updateTransactions).not.toHaveBeenCalled();
});

it('keeps unaffected merchants eligible when identical descriptions share a model result', async () => {
  const client = { provider: 'openai', modelId: 'openai/model', usingUserKey: true };
  const otherRow = { ...row, id: 'other', externalData: { merchant: 'Bookshop' } };
  jest.mocked(createAIClient).mockResolvedValue(client as never);
  jest.mocked(findTransactions).mockResolvedValue([row, otherRow] as never);
  jest.mocked(PayeeIgnoredNames.findAll).mockResolvedValue([{ normalizedName: 'cafe' }] as never);

  expect(
    await applyExtractedPayee({
      userId: 1,
      snapshots: [snapshot, snapshotForExtraction({ row: otherRow as never })],
      name: 'Target',
      destination: extractionDestination({ client }),
    }),
  ).toEqual(['other']);
  expect(updateTransactions).toHaveBeenCalledTimes(1);
});

describe('extraction destination privacy', () => {
  it('detects URL changes under the same endpoint ID without retaining the URL', () => {
    const client = {
      provider: 'custom',
      modelId: 'custom/local',
      customEndpointId: 'endpoint',
      usingUserKey: true,
      customEndpointUrl: 'https://private.example.test/v1',
    };
    const destination = extractionDestination({ client });
    const changed = extractionDestination({
      client: { ...client, customEndpointUrl: 'https://other.example.test/v1' },
    });
    expect(changed).not.toBe(destination);
    expect(destination).toBe(extractionDestination({ client: { ...client } }));
    expect(destination).not.toContain(client.customEndpointUrl);
    expect(destination).not.toContain('private.example.test');
    expect(JSON.parse(destination).at(-1)).toMatch(/^[a-f0-9]{64}$/);
  });
});
