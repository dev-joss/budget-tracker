import { api } from '@/api/_api';
import type {
  ExpensifyConfirmationTier,
  ExpensifyMatchState,
  ExpensifyReportState,
  ExpensifyReviewReason,
  RecordId,
  TransactionModel,
} from '@bt/shared/types';

interface WorkExpenseIntegrationState {
  connected: boolean;
  initialSyncDate: string | null;
  lastAttemptedSyncAt: string | null;
  lastSuccessfulSyncAt: string | null;
  lastErrorCode: string | null;
}

export interface ConnectWorkExpenseIntegrationPayload {
  partnerUserId: string;
  partnerUserSecret: string;
  initialSyncDate?: string;
}

type WorkExpenseSyncState = 'idle' | 'queued' | 'processing' | 'completed' | 'failed';

interface WorkExpenseSyncStatus {
  status: WorkExpenseSyncState;
  runId?: RecordId;
  processedCount?: number;
  importedCount?: number;
  matchedCount?: number;
  reviewCount?: number;
  errorCode?: string;
}

interface WorkExpenseSyncTriggerResponse {
  runId: RecordId;
  status: 'queued';
}

export interface WorkExpenseCandidateTransaction {
  id: RecordId;
  amount: number;
  originalAmount: number | null;
  currencyCode: string;
  originalCurrencyCode: string | null;
  time: string;
  note: string;
  payeeName: string | null;
  accountName: string;
}

export interface WorkExpenseMatchCandidate {
  transactionId: RecordId;
  rank: number;
  compositeScoreBps: number;
  merchantSimilarityBps: number;
  dateDistance: number;
  isReciprocalTop: boolean;
  transaction: WorkExpenseCandidateTransaction;
}

export interface WorkExpenseReconciliationExpense {
  id: RecordId;
  externalExpenseId: string;
  externalReportId: string;
  reportState: ExpensifyReportState;
  originalAmount: number;
  originalCurrencyCode: string;
  expenseDate: string;
  originalMerchant: string;
  modifiedMerchant: string | null;
  isReimbursable: boolean;
  matchState: ExpensifyMatchState;
  linkedTransactionId: RecordId | null;
  confirmationTier: ExpensifyConfirmationTier | null;
  confirmedAt: string | null;
  reviewReasons: ExpensifyReviewReason[];
}

export interface WorkExpenseReconciliationItem {
  expense: WorkExpenseReconciliationExpense;
  candidates: WorkExpenseMatchCandidate[];
}

interface WorkExpenseReconciliationResponse {
  items: WorkExpenseReconciliationItem[];
  total: number;
  limit: number;
  offset: number;
}

export const getWorkExpenseIntegration = async (
  _params: Record<string, never>,
): Promise<WorkExpenseIntegrationState> => {
  return api.get('/work-expenses/integration');
};

export const connectWorkExpenseIntegration = async (
  payload: ConnectWorkExpenseIntegrationPayload,
): Promise<WorkExpenseIntegrationState> => {
  return api.put('/work-expenses/integration', payload);
};

export const disconnectWorkExpenseIntegration = async (
  _params: Record<string, never>,
): Promise<WorkExpenseIntegrationState> => {
  return api.delete('/work-expenses/integration');
};

export const triggerWorkExpenseSync = async (
  _params: Record<string, never>,
): Promise<WorkExpenseSyncTriggerResponse> => {
  return api.post('/work-expenses/sync');
};

export const getWorkExpenseSyncStatus = async (_params: Record<string, never>): Promise<WorkExpenseSyncStatus> => {
  return api.get('/work-expenses/sync/status');
};

export const getWorkExpenseReconciliation = async ({
  state,
  limit,
  offset,
}: {
  state?: ExpensifyMatchState;
  limit?: number;
  offset?: number;
}): Promise<WorkExpenseReconciliationResponse> => {
  return api.get('/work-expenses/reconciliation', { state, limit, offset });
};

export const confirmWorkExpenseMatches = async ({
  matches,
}: {
  matches: { expenseId: RecordId; transactionId: RecordId }[];
}): Promise<{ confirmedCount: number }> => {
  return api.post('/work-expenses/matches/confirm', { matches });
};

export const removeWorkExpenseMatch = async ({
  expenseId,
}: {
  expenseId: RecordId;
}): Promise<{ expenseId: RecordId }> => {
  return api.delete(`/work-expenses/matches/${expenseId}`);
};

export const resolveWorkExpenseReview = async ({
  expenseId,
  action,
  transactionId,
}: {
  expenseId: RecordId;
  action: 'keep' | 'relink';
  transactionId?: RecordId;
}): Promise<WorkExpenseReconciliationItem> => {
  return api.post(`/work-expenses/reviews/${expenseId}/resolve`, { action, transactionId });
};

export const updateTransactionWorkExpense = async ({
  transactionId,
  isWorkExpense,
}: {
  transactionId: RecordId;
  isWorkExpense: boolean;
}): Promise<TransactionModel> => {
  return api.patch(`/work-expenses/transactions/${transactionId}/work-expense`, { isWorkExpense });
};
