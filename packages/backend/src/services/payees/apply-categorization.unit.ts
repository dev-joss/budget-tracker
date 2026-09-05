import { CATEGORIZATION_MODE, CATEGORIZATION_SOURCE } from '@bt/shared/types';
import { beforeEach, describe, expect, it, jest } from '@jest/globals';

jest.mock('@models/payees.model', () => ({ __esModule: true, default: { findOne: jest.fn() } }));
jest.mock('@models/transactions.model', () => ({ __esModule: true, default: { findByPk: jest.fn() } }));
jest.mock('@models/transactions-query', () => ({ updateTransactions: jest.fn() }));
jest.mock('../common/with-transaction', () => ({
  withTransaction: <T extends unknown[], R>(fn: (...args: T) => Promise<R>) => fn,
}));

/* eslint-disable import/first */
import Payees from '@models/payees.model';
import { updateTransactions } from '@models/transactions-query';
import Transactions from '@models/transactions.model';

import { applyPayeeCategorization } from './apply-categorization';
/* eslint-enable import/first */

const row = { id: 'tx-1', categorizationMeta: { source: CATEGORIZATION_SOURCE.ai } };
const input = { accountOwnerUserId: 42, transactionId: 'tx-1', payeeId: 'payee-1' };

beforeEach(() => {
  jest.clearAllMocks();
  jest.mocked(Transactions.findByPk).mockResolvedValue(row as never);
  jest.mocked(Payees.findOne).mockResolvedValue({
    id: 'payee-1',
    defaultCategoryId: 'category-1',
    categorizationMode: CATEGORIZATION_MODE.hint,
  } as never);
});

describe('applyPayeeCategorization', () => {
  it('locks the current row and preserves a completed AI category on a late hint link', async () => {
    const result = await applyPayeeCategorization({ ...input, lateLink: true });
    expect(result).toBe(row);
    expect(Transactions.findByPk).toHaveBeenCalledWith('tx-1', { lock: true });
    expect(updateTransactions).not.toHaveBeenCalled();
  });

  it('keeps inline hint behavior', async () => {
    await applyPayeeCategorization(input);
    expect(updateTransactions).toHaveBeenCalledWith(
      expect.objectContaining({
        values: { categoryId: 'category-1', categorizationMeta: null },
      }),
    );
  });

  it('applies a late enforced category over AI', async () => {
    jest.mocked(Payees.findOne).mockResolvedValue({
      id: 'payee-1',
      defaultCategoryId: 'category-1',
      categorizationMode: CATEGORIZATION_MODE.enforce,
    } as never);
    await applyPayeeCategorization({ ...input, lateLink: true });
    expect(updateTransactions).toHaveBeenCalledWith(
      expect.objectContaining({
        values: expect.objectContaining({
          categorizationMeta: expect.objectContaining({ source: CATEGORIZATION_SOURCE.payeeRule }),
        }),
      }),
    );
  });

  it('preserves a manual category', async () => {
    jest.mocked(Transactions.findByPk).mockResolvedValue({
      ...row,
      categorizationMeta: { source: CATEGORIZATION_SOURCE.manual },
    } as never);
    await applyPayeeCategorization({ ...input, lateLink: true });
    expect(updateTransactions).not.toHaveBeenCalled();
  });
});
