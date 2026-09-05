import { api } from '@/api/_api';
import type {
  PayeeExtractionCandidatesResponse,
  PayeeExtractionScope,
  PayeeExtractionStatus,
  PayeeExtractionTriggerResponse,
} from '@bt/shared/types';

export const loadPayeeExtractionCandidates = ({
  accountIds,
  limit,
  offset,
}: {
  accountIds: string[];
  limit: number;
  offset: number;
}): Promise<PayeeExtractionCandidatesResponse> => {
  const params = new URLSearchParams({ limit: String(limit), offset: String(offset) });
  params.set('accountIds', accountIds.join(','));
  return api.get(`/payees/extraction/candidates?${params}`);
};
export const triggerPayeeExtraction = (scope: PayeeExtractionScope): Promise<PayeeExtractionTriggerResponse> =>
  api.post('/payees/extraction/trigger', scope);
export const loadPayeeExtractionStatus = ({ runId }: { runId?: string }): Promise<PayeeExtractionStatus> =>
  api.get(`/payees/extraction/status${runId ? `?runId=${encodeURIComponent(runId)}` : ''}`);
