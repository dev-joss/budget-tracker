import type { RecordId } from './record-id';

export const WORK_EXPENSE_SOURCES = {
  manual: 'manual',
  expensify: 'expensify',
} as const;

export type WorkExpenseSource = (typeof WORK_EXPENSE_SOURCES)[keyof typeof WORK_EXPENSE_SOURCES];

export const EXPENSIFY_DEFAULT_HISTORY_MONTHS = 12;

export const EXPENSIFY_REPORT_STATES = {
  open: 'OPEN',
  submitted: 'SUBMITTED',
  approved: 'APPROVED',
  reimbursed: 'REIMBURSED',
  archived: 'ARCHIVED',
} as const;

export type ExpensifyReportState = (typeof EXPENSIFY_REPORT_STATES)[keyof typeof EXPENSIFY_REPORT_STATES];

export const EXPENSIFY_ELIGIBLE_REPORT_STATES = [
  EXPENSIFY_REPORT_STATES.submitted,
  EXPENSIFY_REPORT_STATES.approved,
  EXPENSIFY_REPORT_STATES.reimbursed,
  EXPENSIFY_REPORT_STATES.archived,
] as const;

export const EXPENSIFY_MATCH_STATES = {
  exact: 'exact',
  likely: 'likely',
  ambiguous: 'ambiguous',
  unmatched: 'unmatched',
  review: 'review',
} as const;

export type ExpensifyMatchState = (typeof EXPENSIFY_MATCH_STATES)[keyof typeof EXPENSIFY_MATCH_STATES];

export const EXPENSIFY_CONFIRMATION_TIERS = {
  exact: 'exact',
  likely: 'likely',
  ambiguous: 'ambiguous',
} as const;

export type ExpensifyConfirmationTier =
  (typeof EXPENSIFY_CONFIRMATION_TIERS)[keyof typeof EXPENSIFY_CONFIRMATION_TIERS];

export const EXPENSIFY_REVIEW_REASONS = {
  upstreamChanged: 'upstream_changed',
  upstreamMissing: 'upstream_missing',
  upstreamIneligible: 'upstream_ineligible',
  localTransactionChanged: 'local_transaction_changed',
  transactionDeleted: 'transaction_deleted',
} as const;

export type ExpensifyReviewReason = (typeof EXPENSIFY_REVIEW_REASONS)[keyof typeof EXPENSIFY_REVIEW_REASONS];

export const EXPENSIFY_SAFE_ERROR_CODES = {
  authentication: 'authentication',
  rateLimited: 'rate_limited',
  unavailable: 'unavailable',
  invalidResponse: 'invalid_response',
  disconnected: 'disconnected',
  credentialsChanged: 'credentials_changed',
} as const;

export type ExpensifySafeErrorCode = (typeof EXPENSIFY_SAFE_ERROR_CODES)[keyof typeof EXPENSIFY_SAFE_ERROR_CODES];

export interface ExpensifyIntegrationState {
  connected: boolean;
  initialSyncDate: string | null;
  lastAttemptedSyncAt: string | null;
  lastSuccessfulSyncAt: string | null;
  lastErrorCode: ExpensifySafeErrorCode | null;
}

export interface ExpensifySyncCounters {
  processedCount: number;
  importedCount: number;
  matchedCount: number;
  reviewCount: number;
}

export type ExpensifySyncStatus =
  | { status: 'idle' }
  | ({
      status: 'queued' | 'processing' | 'completed' | 'failed';
      runId: RecordId;
      errorCode?: ExpensifySafeErrorCode;
    } & ExpensifySyncCounters);

export interface ExpensifyCandidateTransaction {
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

export interface ExpensifyReconciliationCandidate {
  transactionId: RecordId;
  rank: number;
  compositeScoreBps: number;
  merchantSimilarityBps: number;
  dateDistance: number;
  isReciprocalTop: boolean;
  transaction: ExpensifyCandidateTransaction;
}

export interface ExpensifyReconciliationExpense {
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

export interface ExpensifyReconciliationItem {
  expense: ExpensifyReconciliationExpense;
  candidates: ExpensifyReconciliationCandidate[];
}

export interface ExpensifyReconciliationResponse {
  items: ExpensifyReconciliationItem[];
  total: number;
  limit: number;
  offset: number;
}

/** Safe integration state. The encrypted credential payload is backend-only. */
export interface ExpensifyConnectionModel {
  id: RecordId;
  userId: number;
  initialSyncDate: string;
  credentialRevision: number;
  lastAttemptedSyncAt: Date | null;
  lastSuccessfulSyncAt: Date | null;
  lastErrorCode: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface ExpensifyExpenseModel {
  id: RecordId;
  userId: number;
  externalExpenseId: string;
  externalReportId: string;
  reportState: ExpensifyReportState;
  /** Decimal amount at the API boundary. The database stores cents. */
  originalAmount: number;
  originalCurrencyCode: string;
  expenseDate: string;
  originalMerchant: string;
  modifiedMerchant: string | null;
  isReimbursable: boolean;
  upstreamFingerprint: string;
  lastSeenSynchronizationId: RecordId;
  lastSeenAt: Date;
  matchState: ExpensifyMatchState;
  linkedTransactionId: RecordId | null;
  confirmationTier: ExpensifyConfirmationTier | null;
  confirmedAt: Date | null;
  confirmationFingerprint: string | null;
  reviewReasons: ExpensifyReviewReason[];
  reviewBaseline: Record<string, unknown> | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface ExpensifyMatchCandidateModel {
  id: RecordId;
  userId: number;
  expenseId: RecordId;
  transactionId: RecordId;
  rank: number;
  compositeScoreBps: number;
  merchantSimilarityBps: number;
  dateDistance: number;
  isReciprocalTop: boolean;
}
