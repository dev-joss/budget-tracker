import type { TransactionModel } from './db-models';

export interface PayeeExtractionScope {
  accountIds?: string[];
  transactionIds?: string[];
}

export interface PayeeExtractionCounts {
  scanned: number;
  linked: number;
  skipped: number;
  lowConfidence: number;
  failed: number;
}

export interface PayeeExtractionStatus extends PayeeExtractionCounts {
  runId: string | null;
  status: 'idle' | 'queued' | 'processing' | 'completed' | 'failed';
  totalCount: number;
  error?: string;
}

export interface PayeeExtractionTriggerResponse {
  enqueued: boolean;
  runId: string | null;
  totalCount: number;
}

export interface PayeeExtractionCandidatesResponse<T = TransactionModel> {
  items: T[];
  totalCount: number;
}
