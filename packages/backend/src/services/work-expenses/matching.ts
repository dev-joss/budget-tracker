import { EXPENSIFY_MATCH_STATES, type ExpensifyMatchState, type RecordId } from '@bt/shared/types';
import { normalizePayeeName } from '@services/payees/normalize-name';
import Fuse from 'fuse.js';

export const MATCHING_BOUNDS = {
  maxDateDistanceDays: 3,
  plausibleMerchantBps: 6_000,
  likelyCompositeBps: 7_200,
  requiredMarginBps: 1_200,
  maxCandidatesPerExpense: 20,
} as const;

export interface MatchableExpense {
  id: RecordId;
  amountCents: number;
  currencyCode: string;
  date: string;
  merchant: string;
}

export interface MatchableTransaction {
  id: RecordId;
  amountCents: number;
  currencyCode: string;
  date: string;
  merchant: string;
}

export interface CandidateScore {
  compositeScoreBps: number;
  merchantSimilarityBps: number;
  dateDistance: number;
  normalizedMerchantEqual: boolean;
  sameDate: boolean;
}

export interface CandidateEdge extends CandidateScore {
  expenseId: RecordId;
  transactionId: RecordId;
}

export interface RankedCandidateEdge extends CandidateEdge {
  rank: number;
  isReciprocalTop: boolean;
}

export interface ClassifiedExpenseCandidates {
  expenseId: RecordId;
  state: ExpensifyMatchState;
  candidates: RankedCandidateEdge[];
}

function dateOnlyEpochDay({ value }: { value: string }): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const milliseconds = Date.parse(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(milliseconds)) return null;
  const parsed = new Date(milliseconds);
  if (parsed.toISOString().slice(0, 10) !== value) return null;
  return Math.floor(milliseconds / 86_400_000);
}

export function utcDateDistance({ left, right }: { left: string; right: string }): number | null {
  const leftDay = dateOnlyEpochDay({ value: left });
  const rightDay = dateOnlyEpochDay({ value: right });
  return leftDay === null || rightDay === null ? null : Math.abs(leftDay - rightDay);
}

export function merchantSimilarityBps({ left, right }: { left: string; right: string }): number {
  const normalizedLeft = normalizePayeeName({ raw: left });
  const normalizedRight = normalizePayeeName({ raw: right });
  if (!normalizedLeft || !normalizedRight) return 0;
  if (normalizedLeft === normalizedRight) return 10_000;

  const fuse = new Fuse([normalizedRight], {
    includeScore: true,
    threshold: 1,
    ignoreLocation: true,
    isCaseSensitive: false,
  });
  const score = fuse.search(normalizedLeft)[0]?.score;
  if (score === undefined) return 0;
  return Math.max(0, Math.min(10_000, Math.round((1 - score) * 10_000)));
}

export function scoreCandidate({
  expense,
  transaction,
}: {
  expense: MatchableExpense;
  transaction: MatchableTransaction;
}): CandidateScore | null {
  if (expense.amountCents !== transaction.amountCents || expense.currencyCode !== transaction.currencyCode) {
    return null;
  }

  const dateDistance = utcDateDistance({ left: expense.date, right: transaction.date });
  if (dateDistance === null || dateDistance > MATCHING_BOUNDS.maxDateDistanceDays) return null;

  const merchantBps = merchantSimilarityBps({ left: expense.merchant, right: transaction.merchant });
  const dateBps = Math.round((1 - dateDistance / MATCHING_BOUNDS.maxDateDistanceDays) * 10_000);
  const normalizedMerchantEqual =
    normalizePayeeName({ raw: expense.merchant }) === normalizePayeeName({ raw: transaction.merchant });

  return {
    compositeScoreBps: Math.round(merchantBps * 0.8 + dateBps * 0.2),
    merchantSimilarityBps: merchantBps,
    dateDistance,
    normalizedMerchantEqual,
    sameDate: dateDistance === 0,
  };
}

const edgeOrder = (left: CandidateEdge, right: CandidateEdge): number =>
  right.compositeScoreBps - left.compositeScoreBps ||
  right.merchantSimilarityBps - left.merchantSimilarityBps ||
  left.dateDistance - right.dateDistance ||
  left.transactionId.localeCompare(right.transactionId) ||
  left.expenseId.localeCompare(right.expenseId);

function hasUniqueTop({ edges }: { edges: CandidateEdge[] }): boolean {
  return edges.length === 1 || edges[0]!.compositeScoreBps > edges[1]!.compositeScoreBps;
}

export function classifyCandidateGraph({ edges }: { edges: CandidateEdge[] }): ClassifiedExpenseCandidates[] {
  const byExpense = new Map<RecordId, CandidateEdge[]>();
  const byTransaction = new Map<RecordId, CandidateEdge[]>();

  for (const edge of edges) {
    const expenseEdges = byExpense.get(edge.expenseId) ?? [];
    expenseEdges.push(edge);
    byExpense.set(edge.expenseId, expenseEdges);

    const transactionEdges = byTransaction.get(edge.transactionId) ?? [];
    transactionEdges.push(edge);
    byTransaction.set(edge.transactionId, transactionEdges);
  }

  for (const grouped of [...byExpense.values(), ...byTransaction.values()]) grouped.sort(edgeOrder);

  return [...byExpense.entries()]
    .toSorted(([left], [right]) => left.localeCompare(right))
    .map(([expenseId, expenseEdges]) => {
      const expenseHasUniqueTop = hasUniqueTop({ edges: expenseEdges });
      const ranked = expenseEdges.map((edge, index): RankedCandidateEdge => {
        const transactionEdges = byTransaction.get(edge.transactionId)!;
        const isReciprocalTop =
          index === 0 &&
          expenseHasUniqueTop &&
          transactionEdges[0] === edge &&
          hasUniqueTop({ edges: transactionEdges });
        return { ...edge, rank: index + 1, isReciprocalTop };
      });

      const top = ranked[0]!;
      const plausible = ranked.filter(
        (candidate) => candidate.merchantSimilarityBps >= MATCHING_BOUNDS.plausibleMerchantBps,
      );
      const topTransactionHasOnePlausibleEdge =
        byTransaction
          .get(top.transactionId)!
          .filter((candidate) => candidate.merchantSimilarityBps >= MATCHING_BOUNDS.plausibleMerchantBps).length === 1;
      const hasUncontestedPlausibleEdge = plausible.length === 1 && topTransactionHasOnePlausibleEdge;
      const runnerUp = ranked[1];
      const margin = runnerUp ? top.compositeScoreBps - runnerUp.compositeScoreBps : 10_000;

      let state: ExpensifyMatchState;
      if (top.normalizedMerchantEqual && top.sameDate && top.isReciprocalTop && hasUncontestedPlausibleEdge) {
        state = EXPENSIFY_MATCH_STATES.exact;
      } else if (
        top.isReciprocalTop &&
        hasUncontestedPlausibleEdge &&
        top.compositeScoreBps >= MATCHING_BOUNDS.likelyCompositeBps &&
        margin >= MATCHING_BOUNDS.requiredMarginBps
      ) {
        state = EXPENSIFY_MATCH_STATES.likely;
      } else if (plausible.length > 0) {
        state = EXPENSIFY_MATCH_STATES.ambiguous;
      } else {
        state = EXPENSIFY_MATCH_STATES.unmatched;
      }

      return {
        expenseId,
        state,
        candidates: ranked.slice(0, MATCHING_BOUNDS.maxCandidatesPerExpense),
      };
    });
}
