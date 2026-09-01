import type { PlaidApi, Transaction } from 'plaid';

import { fetchPlaidSyncChanges } from './sync-item';

const response = ({
  nextCursor,
  hasMore,
  added = [],
}: {
  nextCursor: string;
  hasMore: boolean;
  added?: Transaction[];
}) => ({
  data: { added, modified: [], removed: [], next_cursor: nextCursor, has_more: hasMore, request_id: nextCursor },
});

describe('fetchPlaidSyncChanges', () => {
  it('accumulates every page and returns only the final cursor', async () => {
    const transactionsSync = jest
      .fn()
      .mockResolvedValueOnce(
        response({ nextCursor: 'cursor-1', hasMore: true, added: [{ transaction_id: 'one' }] as Transaction[] }),
      )
      .mockResolvedValueOnce(
        response({ nextCursor: 'cursor-2', hasMore: false, added: [{ transaction_id: 'two' }] as Transaction[] }),
      );

    const result = await fetchPlaidSyncChanges({
      apiClient: { transactionsSync } as unknown as PlaidApi,
      accessToken: 'access-token',
      startingCursor: null,
    });

    expect(result.added.map((transaction) => transaction.transaction_id)).toEqual(['one', 'two']);
    expect(result.nextCursor).toBe('cursor-2');
    expect(transactionsSync).toHaveBeenNthCalledWith(2, {
      access_token: 'access-token',
      cursor: 'cursor-1',
      count: 500,
    });
  });

  it('discards partial pages and restarts from the saved cursor after a pagination mutation', async () => {
    const mutationError = {
      response: {
        data: {
          error_code: 'TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION',
          error_type: 'TRANSACTIONS_ERROR',
        },
      },
    };
    const transactionsSync = jest
      .fn()
      .mockResolvedValueOnce(
        response({ nextCursor: 'partial', hasMore: true, added: [{ transaction_id: 'discard' }] as Transaction[] }),
      )
      .mockRejectedValueOnce(mutationError)
      .mockResolvedValueOnce(
        response({ nextCursor: 'final', hasMore: false, added: [{ transaction_id: 'keep' }] as Transaction[] }),
      );

    const result = await fetchPlaidSyncChanges({
      apiClient: { transactionsSync } as unknown as PlaidApi,
      accessToken: 'access-token',
      startingCursor: 'saved',
    });

    expect(result.added.map((transaction) => transaction.transaction_id)).toEqual(['keep']);
    expect(transactionsSync).toHaveBeenNthCalledWith(3, {
      access_token: 'access-token',
      cursor: 'saved',
      count: 500,
    });
  });

  it('does not retry terminal errors', async () => {
    const transactionsSync = jest.fn().mockRejectedValue({
      response: { data: { error_code: 'INVALID_ACCESS_TOKEN', error_type: 'INVALID_INPUT' } },
    });

    await expect(
      fetchPlaidSyncChanges({
        apiClient: { transactionsSync } as unknown as PlaidApi,
        accessToken: 'access-token',
        startingCursor: null,
      }),
    ).rejects.toBeDefined();
    expect(transactionsSync).toHaveBeenCalledTimes(1);
  });
});
