import { beforeEach, describe, expect, it, vi } from 'vitest';

import { api } from './_api';
import { loadPayeeExtractionCandidates, loadPayeeExtractionStatus, triggerPayeeExtraction } from './payee-extraction';

vi.mock('./_api', () => ({ api: { get: vi.fn(), post: vi.fn() } }));

beforeEach(() => vi.clearAllMocks());

describe('payee extraction API', () => {
  it('retains each selected account and bounded page parameters', async () => {
    await loadPayeeExtractionCandidates({ accountIds: ['account-a', 'account-b'], limit: 50, offset: 100 });
    const url = new URL(vi.mocked(api.get).mock.calls[0]![0], 'https://example.test');
    expect(url.pathname).toBe('/payees/extraction/candidates');
    expect(url.searchParams.get('accountIds')).toBe('account-a,account-b');
    expect(url.searchParams.has('accountIds[]')).toBe(false);
    expect(url.searchParams.get('limit')).toBe('50');
    expect(url.searchParams.get('offset')).toBe('100');
  });
  it('sends selected IDs without broadening the run scope', async () => {
    await triggerPayeeExtraction({ accountIds: ['account-a'], transactionIds: ['transaction-a'] });
    expect(api.post).toHaveBeenCalledWith('/payees/extraction/trigger', {
      accountIds: ['account-a'],
      transactionIds: ['transaction-a'],
    });
  });
  it('loads extraction status independently from categorization and restores latest on reload', async () => {
    await loadPayeeExtractionStatus({});
    expect(api.get).toHaveBeenLastCalledWith('/payees/extraction/status');
    await loadPayeeExtractionStatus({ runId: 'run/1' });
    expect(api.get).toHaveBeenLastCalledWith('/payees/extraction/status?runId=run%2F1');
  });
});
