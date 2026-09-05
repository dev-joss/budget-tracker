import { ACCOUNT_TYPES, ImportSource, type PayeeExtractionScope } from '@bt/shared/types';
import { t } from '@i18n/index';
import { NotFoundError } from '@js/errors';
import Accounts from '@models/accounts.model';
import { countTransactions, findTransactions } from '@models/transactions-query';
import { Op, literal, type WhereOptions } from 'sequelize';

export const EXTRACTION_PAGE_SIZE = 200;

export async function assertExtractionScope({ userId, accountIds }: { userId: number; accountIds?: string[] }) {
  if (!accountIds) return;
  const count = await Accounts.count({ where: { userId, id: accountIds } });
  if (count !== new Set(accountIds).size) throw new NotFoundError({ message: t({ key: 'payees.notFound' }) });
}

export function extractionWhere({
  scope = {},
  cutoff,
  cursor,
}: {
  scope?: PayeeExtractionScope;
  cutoff?: string;
  cursor?: string;
}): WhereOptions {
  return {
    payeeId: null,
    payeeLocked: false,
    ...(scope.accountIds && { accountId: { [Op.in]: scope.accountIds } }),
    ...(cutoff && { createdAt: { [Op.lte]: new Date(cutoff) } }),
    [Op.and]: [
      ...(scope.transactionIds ? [{ id: { [Op.in]: scope.transactionIds } }] : []),
      ...(cursor ? [{ id: { [Op.gt]: cursor } }] : []),
      literal(`coalesce("Transactions"."note", '') ~ '[^[:space:]]'`),
      literal(`("Transactions"."externalData" #>> '{plaid,removedAt}') IS NULL`),
      {
        [Op.or]: [
          { accountType: { [Op.ne]: ACCOUNT_TYPES.system }, originalId: { [Op.ne]: null } },
          literal(`coalesce("Transactions"."externalData" #>> '{originalSource,originalId}', '') <> ''`),
          {
            'externalData.importDetails.source': { [Op.in]: Object.values(ImportSource) },
            'externalData.importDetails.batchId': { [Op.ne]: null },
          },
        ],
      },
    ],
  };
}

export const extractionPolicy = ({ userId }: { userId: number }) => ({
  planned: 'exclude' as const,
  balanceAdjustments: 'exclude' as const,
  transfers: 'exclude' as const,
  access: { accountOwner: userId },
});

export async function countExtractionCandidates({
  userId,
  scope = {},
  cutoff,
}: {
  userId: number;
  scope?: PayeeExtractionScope;
  cutoff?: string;
}): Promise<number> {
  return countTransactions({ ...extractionPolicy({ userId }), where: extractionWhere({ scope, cutoff }) });
}

export async function listExtractionCandidates({
  userId,
  accountIds,
  limit = 30,
  offset = 0,
}: {
  userId: number;
  accountIds?: string[];
  limit?: number;
  offset?: number;
}) {
  await assertExtractionScope({ userId, accountIds });
  const scope = { accountIds };
  const [items, totalCount] = await Promise.all([
    findTransactions({
      ...extractionPolicy({ userId }),
      where: extractionWhere({ scope }),
      completeness: { page: { limit, offset } },
      order: [
        ['time', 'DESC'],
        ['id', 'ASC'],
      ],
    }),
    countExtractionCandidates({ userId, scope }),
  ]);
  return { items, totalCount };
}
