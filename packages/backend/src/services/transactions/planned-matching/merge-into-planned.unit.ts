import { ACCOUNT_TYPES } from '@bt/shared/types';
import { Money } from '@common/types/money';
import { describe, expect, it, jest } from '@jest/globals';

jest.mock('@models/transactions.model', () => ({ __esModule: true, default: {} }));
jest.mock('@services/calculate-ref-amount.service', () => ({ calculateRefAmount: jest.fn() }));
jest.mock('@services/payees/resolve-payee-for-incoming-row', () => ({
  resolvePayeeForIncomingRow: jest.fn(),
}));

/* eslint-disable import/first */
import { resolvePayeeForIncomingRow } from '@services/payees/resolve-payee-for-incoming-row';

import { mergeIntoPlanned } from './merge-into-planned';
/* eslint-enable import/first */

describe('mergeIntoPlanned payee ownership', () => {
  it('resolves the payee in the account owner namespace', async () => {
    jest.mocked(resolvePayeeForIncomingRow).mockResolvedValue('payee-1');
    const planned = {
      id: 'tx-1',
      userId: 99,
      accountId: 'account-1',
      currencyCode: 'USD',
      refCurrencyCode: 'USD',
      amount: Money.fromDecimal(20),
      payeeId: null,
      payeeLocked: false,
      update: jest.fn<() => Promise<void>>().mockResolvedValue(),
    };
    await mergeIntoPlanned({
      accountOwnerUserId: 42,
      planned: planned as never,
      incoming: { time: new Date(), accountType: ACCOUNT_TYPES.system, rawMerchantName: 'Amazon' },
    });
    expect(resolvePayeeForIncomingRow).toHaveBeenCalledWith(expect.objectContaining({ ownerUserId: 42 }));
    expect(planned.update).toHaveBeenCalledWith(expect.objectContaining({ payeeId: 'payee-1', isPlanned: false }));
  });
});
