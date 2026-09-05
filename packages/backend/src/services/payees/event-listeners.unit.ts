import { eventBus } from '@services/common/event-bus';
import { schedulePayeeExtraction } from '@services/payees/ai-extraction/schedule';
import { getUserSettings } from '@services/user-settings/get-user-settings';

import { registerPayeeNoteBackfillListeners } from './event-listeners';
import { runNoteFuzzyBackfill } from './note-fuzzy-backfill';

jest.mock('@js/utils/logger', () => ({ logger: { info: jest.fn(), error: jest.fn() } }));
jest.mock('@services/common/event-bus', () => ({
  DOMAIN_EVENTS: { TRANSACTIONS_SYNCED: 'synced' },
  eventBus: { on: jest.fn() },
}));
jest.mock('@services/payees/ai-extraction/schedule', () => ({ schedulePayeeExtraction: jest.fn() }));
jest.mock('@services/user-settings/get-user-settings', () => ({ getUserSettings: jest.fn() }));
jest.mock('./note-fuzzy-backfill', () => ({ runNoteFuzzyBackfill: jest.fn() }));

beforeEach(() => {
  jest.useFakeTimers();
  jest.clearAllMocks();
  registerPayeeNoteBackfillListeners();
});
afterEach(() => jest.useRealTimers());

const emitSync = () => {
  const handler = jest.mocked(eventBus.on).mock.calls[0]![1];
  handler({ userId: 1, accountId: 'account', transactionIds: ['first', 'second'] });
};

it('finishes the deterministic description pass before scheduling AI', async () => {
  jest
    .mocked(getUserSettings)
    .mockResolvedValue({ payeeExtractionUsesDescription: true } as Awaited<ReturnType<typeof getUserSettings>>);
  jest.mocked(runNoteFuzzyBackfill).mockResolvedValue({ scanned: 2, linked: 1 });
  jest.mocked(schedulePayeeExtraction).mockResolvedValue(undefined);

  emitSync();
  expect(schedulePayeeExtraction).not.toHaveBeenCalled();
  await jest.runAllTimersAsync();

  expect(schedulePayeeExtraction).toHaveBeenCalledWith({ userId: 1, transactionIds: ['first', 'second'] });
  expect(jest.mocked(runNoteFuzzyBackfill).mock.invocationCallOrder[0]).toBeLessThan(
    jest.mocked(schedulePayeeExtraction).mock.invocationCallOrder[0]!,
  );
});

it('does not schedule descriptions when description consent is disabled', async () => {
  jest
    .mocked(getUserSettings)
    .mockResolvedValue({ payeeExtractionUsesDescription: false } as Awaited<ReturnType<typeof getUserSettings>>);

  emitSync();
  await jest.runAllTimersAsync();

  expect(runNoteFuzzyBackfill).not.toHaveBeenCalled();
  expect(schedulePayeeExtraction).not.toHaveBeenCalled();
});

it('does not schedule AI when the deterministic pass fails', async () => {
  jest
    .mocked(getUserSettings)
    .mockResolvedValue({ payeeExtractionUsesDescription: true } as Awaited<ReturnType<typeof getUserSettings>>);
  jest.mocked(runNoteFuzzyBackfill).mockRejectedValue(new Error('failed'));

  emitSync();
  await jest.runAllTimersAsync();

  expect(schedulePayeeExtraction).not.toHaveBeenCalled();
});
