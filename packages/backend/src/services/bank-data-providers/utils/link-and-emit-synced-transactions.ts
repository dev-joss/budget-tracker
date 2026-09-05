import { namespace } from '@models/connection';
import { schedulePayeeExtraction } from '@services/payees/ai-extraction/schedule';

import { autoLinkTransfers } from './auto-link-transfers';
import { emitTransactionsSyncEvent } from './emit-transactions-sync-event';

export async function linkAndEmitSyncedTransactions({
  userId,
  accountId,
  transactionIds,
  extraAutoLinkCandidateIds,
  payeeExtractionTransactionIds,
}: {
  userId: number;
  accountId: string;
  transactionIds: string[];
  extraAutoLinkCandidateIds?: string[];
  payeeExtractionTransactionIds?: string[];
}): Promise<void> {
  const autoLinkedIds = await autoLinkTransfers({
    userId,
    transactionIds: [...transactionIds, ...(extraAutoLinkCandidateIds ?? [])],
  });

  const completeSync = async () => {
    await schedulePayeeExtraction({
      userId,
      transactionIds: [...(payeeExtractionTransactionIds ?? []), ...(extraAutoLinkCandidateIds ?? [])].filter(
        (id) => !autoLinkedIds.has(id),
      ),
    });

    emitTransactionsSyncEvent({
      userId,
      accountId,
      transactionIds: transactionIds.filter((id) => !autoLinkedIds.has(id)),
    });
  };
  const transaction = namespace.get('transaction');
  if (transaction && !transaction.finished) {
    transaction.afterCommit(completeSync);
  } else {
    await completeSync();
  }
}
