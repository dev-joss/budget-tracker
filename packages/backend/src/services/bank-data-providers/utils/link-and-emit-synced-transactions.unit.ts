import { namespace } from '@models/connection';
import { schedulePayeeExtraction } from '@services/payees/ai-extraction/schedule';

import { autoLinkTransfers } from './auto-link-transfers';
import { emitTransactionsSyncEvent } from './emit-transactions-sync-event';
import { linkAndEmitSyncedTransactions } from './link-and-emit-synced-transactions';

jest.mock('@models/connection', () => ({ namespace: { get: jest.fn() } }));
jest.mock('@services/payees/ai-extraction/schedule', () => ({ schedulePayeeExtraction: jest.fn() }));
jest.mock('./auto-link-transfers', () => ({ autoLinkTransfers: jest.fn() }));
jest.mock('./emit-transactions-sync-event', () => ({ emitTransactionsSyncEvent: jest.fn() }));

beforeEach(() => jest.clearAllMocks());

it('schedules extra payee rows after transfer matching without adding them to categorization events', async () => {
  jest.mocked(autoLinkTransfers).mockResolvedValue(new Set(['transfer']));
  jest.mocked(schedulePayeeExtraction).mockResolvedValue(undefined);

  await linkAndEmitSyncedTransactions({
    userId: 1,
    accountId: 'account',
    transactionIds: ['new', 'transfer'],
    extraAutoLinkCandidateIds: ['booked', 'transfer'],
    payeeExtractionTransactionIds: ['merged', 'modified'],
  });

  expect(schedulePayeeExtraction).toHaveBeenCalledWith({
    userId: 1,
    transactionIds: ['merged', 'modified', 'booked'],
  });
  expect(emitTransactionsSyncEvent).toHaveBeenCalledWith({
    userId: 1,
    accountId: 'account',
    transactionIds: ['new'],
  });
  expect(jest.mocked(autoLinkTransfers).mock.invocationCallOrder[0]).toBeLessThan(
    jest.mocked(schedulePayeeExtraction).mock.invocationCallOrder[0]!,
  );
});

it('waits for an outer transaction to commit before enqueueing or emitting events', async () => {
  let afterCommit: (() => Promise<void>) | undefined;
  jest.mocked(namespace.get).mockReturnValue({
    afterCommit: (callback: () => Promise<void>) => {
      afterCommit = callback;
    },
  });
  jest.mocked(autoLinkTransfers).mockResolvedValue(new Set());
  jest.mocked(schedulePayeeExtraction).mockResolvedValue(undefined);

  await linkAndEmitSyncedTransactions({
    userId: 1,
    accountId: 'account',
    transactionIds: ['new'],
    payeeExtractionTransactionIds: ['merged'],
  });
  expect(schedulePayeeExtraction).not.toHaveBeenCalled();
  expect(emitTransactionsSyncEvent).not.toHaveBeenCalled();
  expect(afterCommit).toBeDefined();

  await afterCommit!();
  expect(schedulePayeeExtraction).toHaveBeenCalledWith({ userId: 1, transactionIds: ['merged'] });
  expect(emitTransactionsSyncEvent).toHaveBeenCalledWith({ userId: 1, accountId: 'account', transactionIds: ['new'] });
});
