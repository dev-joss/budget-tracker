import { AI_FEATURE } from '@bt/shared/types';
import PayeeAliases from '@models/payee-aliases.model';
import PayeeIgnoredNames from '@models/payee-ignored-names.model';
import Payees from '@models/payees.model';
import { findTransactions, updateTransactions } from '@models/transactions-query';
import type Transactions from '@models/transactions.model';
import { createAIClient } from '@services/ai';
import { withTransaction } from '@services/common/with-transaction';
import { getUserSettings } from '@services/user-settings/get-user-settings';
import { createHash } from 'node:crypto';

import { applyPayeeCategorization } from '../apply-categorization';
import { applyPayeeDefaultTags } from '../apply-default-tags';
import { extractRawFromTransaction } from '../extraction.service';
import { buildHaystack, fuzzyFindBestMatch } from '../fuzzy-matcher';
import { normalizePayeeName } from '../normalize-name';
import { ensureAliasExists, lockPayeeNamespace, resolveNormalizedName } from '../payee-namespace';
import { createPayee } from '../payees.service';
import { extractionPolicy, extractionWhere } from './candidates';

export interface ExtractionSnapshot {
  id: string;
  accountId: string;
  description: string;
  merchant: string;
}

export function snapshotForExtraction({ row }: { row: Transactions }): ExtractionSnapshot {
  return {
    id: row.id,
    accountId: row.accountId,
    description: row.note?.trim() ?? '',
    merchant: extractRawFromTransaction({ externalData: row.externalData, note: null }).trim(),
  };
}

export async function extractionEnabled({ userId }: { userId: number }): Promise<boolean> {
  const settings = await getUserSettings({ userId });
  return settings.payeeAiExtractionEnabled === true && settings.payeeExtractionUsesDescription === true;
}

async function deterministicPayee({
  userId,
  snapshot,
  repeatedSources,
}: {
  userId: number;
  snapshot: ExtractionSnapshot;
  repeatedSources: Set<string>;
}): Promise<string | null> {
  const payees = await Payees.findAll({ where: { userId }, include: [{ model: PayeeAliases, as: 'aliases' }] });
  const haystack = buildHaystack({ payees });
  const sources = [...new Set([snapshot.merchant, snapshot.description].filter(Boolean))];
  for (const raw of sources) {
    const normalized = normalizePayeeName({ raw });
    if (!normalized) continue;
    const exact = await resolveNormalizedName({ userId, normalized });
    if (exact) return exact.payeeId;
    if (await PayeeIgnoredNames.findOne({ where: { userId, normalizedName: normalized } })) continue;
    const fuzzy = fuzzyFindBestMatch({ haystack, query: raw });
    if (fuzzy) {
      if (raw.length <= 500)
        await ensureAliasExists({ payeeId: fuzzy.payeeId, rawName: raw, normalizedName: normalized });
      return fuzzy.payeeId;
    }
    // Occurrence promotion follows the source merchant, or the description when no merchant exists.
    if (raw === (snapshot.merchant || snapshot.description) && raw.length <= 200 && repeatedSources.has(normalized)) {
      return (await createPayee({ userId, name: raw })).id;
    }
  }
  return null;
}

export const resolveStoredPayee = withTransaction(
  async ({
    userId,
    snapshot,
    repeatedSources,
  }: {
    userId: number;
    snapshot: ExtractionSnapshot;
    repeatedSources: Set<string>;
  }): Promise<'linked' | 'unresolved' | 'skipped'> => {
    await lockPayeeNamespace({ userId });
    if (!(await extractionEnabled({ userId }))) return 'skipped';
    const [row] = await findTransactions({
      ...extractionPolicy({ userId }),
      where: extractionWhere({ scope: { transactionIds: [snapshot.id] } }),
      completeness: 'all',
      lock: true,
    });
    if (!row || !matchesSnapshot({ row, snapshot })) return 'skipped';
    const normalizedSources = [
      ...new Set([snapshot.merchant, snapshot.description].map((raw) => normalizePayeeName({ raw })).filter(Boolean)),
    ];
    if (
      normalizedSources.length &&
      (await PayeeIgnoredNames.findOne({ where: { userId, normalizedName: normalizedSources } }))
    ) {
      for (const normalized of normalizedSources) {
        const exact = await resolveNormalizedName({ userId, normalized });
        if (exact)
          return (await linkRow({ userId, transactionId: row.id, payeeId: exact.payeeId })) ? 'linked' : 'skipped';
      }
      return 'skipped';
    }

    const payeeId = await deterministicPayee({ userId, snapshot, repeatedSources });
    if (!payeeId) return 'unresolved';
    return (await linkRow({ userId, transactionId: row.id, payeeId })) ? 'linked' : 'skipped';
  },
);

function matchesSnapshot({ row, snapshot }: { row: Transactions; snapshot: ExtractionSnapshot }): boolean {
  const current = snapshotForExtraction({ row });
  return (
    current.accountId === snapshot.accountId &&
    current.description === snapshot.description &&
    current.merchant === snapshot.merchant
  );
}

async function linkRow({ userId, transactionId, payeeId }: { userId: number; transactionId: string; payeeId: string }) {
  const [affected] = await updateTransactions({
    ...extractionPolicy({ userId }),
    values: { payeeId },
    where: extractionWhere({ scope: { transactionIds: [transactionId] } }),
  });
  if (!affected) return false;
  await applyPayeeCategorization({ accountOwnerUserId: userId, transactionId, payeeId, lateLink: true });
  await applyPayeeDefaultTags({ accountOwnerUserId: userId, transactionId, payeeId });
  return true;
}

export const applyExtractedPayee = withTransaction(
  async ({
    userId,
    snapshots,
    name,
    destination,
  }: {
    userId: number;
    snapshots: ExtractionSnapshot[];
    name: string;
    destination: string;
  }): Promise<string[]> => {
    await lockPayeeNamespace({ userId });
    if (!(await extractionEnabled({ userId }))) return [];
    const client = await createAIClient({ userId, feature: AI_FEATURE.payeeExtraction });
    if (!client || extractionDestination({ client }) !== destination) return [];
    const byId = new Map(snapshots.map((snapshot) => [snapshot.id, snapshot]));
    const rows = await findTransactions({
      ...extractionPolicy({ userId }),
      where: extractionWhere({ scope: { transactionIds: snapshots.map((snapshot) => snapshot.id) } }),
      completeness: 'all',
      lock: true,
      order: [['id', 'ASC']],
    });
    const eligible = rows.filter((row) => matchesSnapshot({ row, snapshot: byId.get(row.id)! }));
    if (!eligible.length) return [];
    const source = snapshots[0]!.description;
    const normalized = normalizePayeeName({ raw: name });
    const normalizedSource = normalizePayeeName({ raw: source });
    if (!normalized || !normalizedSource || normalized.length > 200) return [];
    const sourceHit = await resolveNormalizedName({ userId, normalized: normalizedSource });
    const targetHit = await resolveNormalizedName({ userId, normalized });
    // A user mapping added during the request wins; a conflicting AI alias is never moved.
    if (sourceHit && (!targetHit || sourceHit.payeeId !== targetHit.payeeId)) return [];
    const merchantById = new Map(
      eligible.map((row) => [row.id, normalizePayeeName({ raw: byId.get(row.id)!.merchant })]),
    );
    const ignored = await PayeeIgnoredNames.findAll({
      where: {
        userId,
        normalizedName: [...new Set([normalized, normalizedSource, ...merchantById.values()].filter(Boolean))],
      },
      attributes: ['normalizedName'],
    });
    const ignoredNames = new Set(ignored.map((entry) => entry.normalizedName));
    if (ignoredNames.has(normalized) || ignoredNames.has(normalizedSource)) return [];
    const linkable = eligible.filter((row) => !ignoredNames.has(merchantById.get(row.id)!));
    if (!linkable.length) return [];
    const payeeId = targetHit?.payeeId ?? (await createPayee({ userId, name })).id;
    const linked: string[] = [];
    for (const row of linkable) {
      if (await linkRow({ userId, transactionId: row.id, payeeId })) linked.push(row.id);
    }
    if (linked.length) await ensureAliasExists({ payeeId, rawName: source, normalizedName: normalizedSource });
    return linked;
  },
);

export function extractionDestination({
  client,
}: {
  client: {
    provider: string;
    modelId: string;
    customEndpointId?: string;
    customEndpointUrl?: string;
    usingUserKey: boolean;
  };
}): string {
  const endpointUrlHash = client.customEndpointUrl
    ? createHash('sha256').update(client.customEndpointUrl).digest('hex')
    : null;
  return JSON.stringify([
    client.provider,
    client.modelId,
    client.customEndpointId,
    client.usingUserKey,
    endpointUrlHash,
  ]);
}
