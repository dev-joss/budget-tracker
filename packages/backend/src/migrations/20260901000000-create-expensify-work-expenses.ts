import { DataTypes, QueryInterface } from 'sequelize';

import { createRealTransactionsViewSql, dropRealTransactionsViewSql } from './utils/real-transactions-view';

const WORK_EXPENSE_SOURCES = ['manual', 'expensify'] as const;
const EXPENSIFY_REPORT_STATES = ['OPEN', 'SUBMITTED', 'APPROVED', 'REIMBURSED', 'ARCHIVED'] as const;
const EXPENSIFY_MATCH_STATES = ['exact', 'likely', 'ambiguous', 'unmatched', 'review'] as const;
const EXPENSIFY_CONFIRMATION_TIERS = ['exact', 'likely', 'ambiguous'] as const;
const EXPENSIFY_UNMATCHED_STATE = 'unmatched';
const EXPENSIFY_REVIEW_STATE = 'review';
const TRANSACTION_DELETED_REVIEW_REASON = 'transaction_deleted';

const inClause = ({ values }: { values: readonly string[] }): string =>
  values.map((value) => `'${value.replace(/'/g, "''")}'`).join(', ');

module.exports = {
  up: async (queryInterface: QueryInterface): Promise<void> => {
    await queryInterface.sequelize.transaction(async (transaction) => {
      await queryInterface.sequelize.query(dropRealTransactionsViewSql, { transaction });

      await queryInterface.addColumn(
        'Transactions',
        'isWorkExpense',
        {
          type: DataTypes.BOOLEAN,
          allowNull: false,
          defaultValue: false,
        },
        { transaction },
      );
      await queryInterface.addColumn(
        'Transactions',
        'workExpenseSource',
        {
          type: DataTypes.STRING(20),
          allowNull: true,
          defaultValue: null,
        },
        { transaction },
      );
      await queryInterface.sequelize.query(
        `ALTER TABLE "Transactions" ADD CONSTRAINT "Transactions_workExpenseSource_check"
         CHECK ("workExpenseSource" IS NULL OR "workExpenseSource" IN (${inClause({ values: WORK_EXPENSE_SOURCES })}));`,
        { transaction },
      );

      await queryInterface.createTable(
        'ExpensifyConnections',
        {
          id: { type: DataTypes.UUID, primaryKey: true, allowNull: false },
          userId: {
            type: DataTypes.INTEGER,
            allowNull: false,
            references: { model: 'Users', key: 'id' },
            onUpdate: 'CASCADE',
            onDelete: 'CASCADE',
          },
          encryptedCredentials: {
            type: DataTypes.TEXT,
            allowNull: true,
            defaultValue: null,
            comment: 'AES-256-GCM payload containing both Expensify credentials',
          },
          initialSyncDate: { type: DataTypes.DATEONLY, allowNull: false },
          credentialRevision: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 1 },
          activeSynchronizationRunId: { type: DataTypes.UUID, allowNull: true, defaultValue: null },
          lastAttemptedSyncAt: { type: DataTypes.DATE, allowNull: true, defaultValue: null },
          lastSuccessfulSyncAt: { type: DataTypes.DATE, allowNull: true, defaultValue: null },
          lastErrorCode: { type: DataTypes.STRING(50), allowNull: true, defaultValue: null },
          createdAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
          updatedAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
        },
        { transaction },
      );
      await queryInterface.addIndex('ExpensifyConnections', ['userId'], {
        name: 'expensify_connections_user_id_unique',
        unique: true,
        transaction,
      });
      await queryInterface.sequelize.query(
        `ALTER TABLE "ExpensifyConnections" ADD CONSTRAINT "ExpensifyConnections_credentialRevision_check"
         CHECK ("credentialRevision" >= 1);`,
        { transaction },
      );

      await queryInterface.createTable(
        'ExpensifyExpenses',
        {
          id: { type: DataTypes.UUID, primaryKey: true, allowNull: false },
          userId: {
            type: DataTypes.INTEGER,
            allowNull: false,
            references: { model: 'Users', key: 'id' },
            onUpdate: 'CASCADE',
            onDelete: 'CASCADE',
          },
          externalExpenseId: { type: DataTypes.STRING(255), allowNull: false },
          externalReportId: { type: DataTypes.STRING(255), allowNull: false },
          reportState: { type: DataTypes.STRING(30), allowNull: false },
          originalAmount: {
            type: DataTypes.BIGINT,
            allowNull: false,
            comment: 'Original Expensify amount in cents',
          },
          originalCurrencyCode: {
            type: DataTypes.STRING(3),
            allowNull: false,
            references: { model: 'Currencies', key: 'code' },
            onUpdate: 'CASCADE',
            onDelete: 'RESTRICT',
          },
          expenseDate: { type: DataTypes.DATEONLY, allowNull: false },
          originalMerchant: { type: DataTypes.TEXT, allowNull: false },
          modifiedMerchant: { type: DataTypes.TEXT, allowNull: true, defaultValue: null },
          isReimbursable: { type: DataTypes.BOOLEAN, allowNull: false },
          upstreamFingerprint: { type: DataTypes.STRING(64), allowNull: false },
          lastSeenSynchronizationId: { type: DataTypes.UUID, allowNull: false },
          lastSeenAt: { type: DataTypes.DATE, allowNull: false },
          matchState: {
            type: DataTypes.STRING(20),
            allowNull: false,
            defaultValue: EXPENSIFY_UNMATCHED_STATE,
          },
          linkedTransactionId: {
            type: DataTypes.UUID,
            allowNull: true,
            defaultValue: null,
            references: { model: 'Transactions', key: 'id' },
            onUpdate: 'CASCADE',
            onDelete: 'SET NULL',
          },
          confirmationTier: { type: DataTypes.STRING(20), allowNull: true, defaultValue: null },
          confirmedAt: { type: DataTypes.DATE, allowNull: true, defaultValue: null },
          confirmationFingerprint: { type: DataTypes.STRING(64), allowNull: true, defaultValue: null },
          reviewReasons: { type: DataTypes.JSONB, allowNull: false, defaultValue: [] },
          reviewBaseline: { type: DataTypes.JSONB, allowNull: true, defaultValue: null },
          createdAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
          updatedAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
        },
        { transaction },
      );
      await queryInterface.addIndex('ExpensifyExpenses', ['userId', 'externalExpenseId'], {
        name: 'expensify_expenses_user_external_expense_unique',
        unique: true,
        transaction,
      });
      await queryInterface.addIndex('ExpensifyExpenses', ['userId', 'matchState'], {
        name: 'expensify_expenses_user_match_state',
        transaction,
      });
      await queryInterface.addIndex('ExpensifyExpenses', ['userId', 'externalReportId'], {
        name: 'expensify_expenses_user_report',
        transaction,
      });
      await queryInterface.sequelize.query(
        `CREATE UNIQUE INDEX "expensify_expenses_linked_transaction_unique"
         ON "ExpensifyExpenses" ("linkedTransactionId")
         WHERE "linkedTransactionId" IS NOT NULL;`,
        { transaction },
      );
      await queryInterface.sequelize.query(
        `ALTER TABLE "ExpensifyExpenses" ADD CONSTRAINT "ExpensifyExpenses_reportState_check"
         CHECK ("reportState" IN (${inClause({ values: EXPENSIFY_REPORT_STATES })}));`,
        { transaction },
      );
      await queryInterface.sequelize.query(
        `ALTER TABLE "ExpensifyExpenses" ADD CONSTRAINT "ExpensifyExpenses_matchState_check"
         CHECK ("matchState" IN (${inClause({ values: EXPENSIFY_MATCH_STATES })}));`,
        { transaction },
      );
      await queryInterface.sequelize.query(
        `ALTER TABLE "ExpensifyExpenses" ADD CONSTRAINT "ExpensifyExpenses_confirmationTier_check"
         CHECK ("confirmationTier" IS NULL OR "confirmationTier" IN (${inClause({ values: EXPENSIFY_CONFIRMATION_TIERS })}));`,
        { transaction },
      );
      await queryInterface.sequelize.query(
        `ALTER TABLE "ExpensifyExpenses" ADD CONSTRAINT "ExpensifyExpenses_reviewReasons_check"
         CHECK (jsonb_typeof("reviewReasons") = 'array');`,
        { transaction },
      );

      await queryInterface.createTable(
        'ExpensifyMatchCandidates',
        {
          id: { type: DataTypes.UUID, primaryKey: true, allowNull: false },
          userId: {
            type: DataTypes.INTEGER,
            allowNull: false,
            references: { model: 'Users', key: 'id' },
            onUpdate: 'CASCADE',
            onDelete: 'CASCADE',
          },
          expenseId: {
            type: DataTypes.UUID,
            allowNull: false,
            references: { model: 'ExpensifyExpenses', key: 'id' },
            onUpdate: 'CASCADE',
            onDelete: 'CASCADE',
          },
          transactionId: {
            type: DataTypes.UUID,
            allowNull: false,
            references: { model: 'Transactions', key: 'id' },
            onUpdate: 'CASCADE',
            onDelete: 'CASCADE',
          },
          rank: { type: DataTypes.INTEGER, allowNull: false },
          compositeScoreBps: { type: DataTypes.SMALLINT, allowNull: false },
          merchantSimilarityBps: { type: DataTypes.SMALLINT, allowNull: false },
          dateDistance: { type: DataTypes.SMALLINT, allowNull: false },
          isReciprocalTop: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
        },
        { transaction },
      );
      await queryInterface.addIndex('ExpensifyMatchCandidates', ['expenseId', 'transactionId'], {
        name: 'expensify_match_candidates_expense_transaction_unique',
        unique: true,
        transaction,
      });
      await queryInterface.addIndex('ExpensifyMatchCandidates', ['transactionId'], {
        name: 'expensify_match_candidates_transaction_id',
        transaction,
      });
      await queryInterface.addIndex('ExpensifyMatchCandidates', ['userId', 'expenseId', 'rank'], {
        name: 'expensify_match_candidates_user_expense_rank',
        transaction,
      });
      await queryInterface.sequelize.query(
        `ALTER TABLE "ExpensifyMatchCandidates" ADD CONSTRAINT "ExpensifyMatchCandidates_rank_check"
         CHECK ("rank" >= 1);`,
        { transaction },
      );
      await queryInterface.sequelize.query(
        `ALTER TABLE "ExpensifyMatchCandidates" ADD CONSTRAINT "ExpensifyMatchCandidates_scores_check"
         CHECK (
           "compositeScoreBps" BETWEEN 0 AND 10000
           AND "merchantSimilarityBps" BETWEEN 0 AND 10000
           AND "dateDistance" BETWEEN 0 AND 3
         );`,
        { transaction },
      );

      await queryInterface.sequelize.query(
        `CREATE FUNCTION mark_expensify_expense_review_on_transaction_delete()
         RETURNS TRIGGER AS $$
         BEGIN
           UPDATE "ExpensifyExpenses"
           SET
             "matchState" = '${EXPENSIFY_REVIEW_STATE}',
             "reviewReasons" = CASE
               WHEN "reviewReasons" ? '${TRANSACTION_DELETED_REVIEW_REASON}' THEN "reviewReasons"
               ELSE "reviewReasons" || '["${TRANSACTION_DELETED_REVIEW_REASON}"]'::jsonb
             END,
             "updatedAt" = NOW()
           WHERE "linkedTransactionId" = OLD."id";
           RETURN OLD;
         END;
         $$ LANGUAGE plpgsql;`,
        { transaction },
      );
      await queryInterface.sequelize.query(
        `CREATE TRIGGER expensify_expense_review_on_transaction_delete
         BEFORE DELETE ON "Transactions"
         FOR EACH ROW EXECUTE FUNCTION mark_expensify_expense_review_on_transaction_delete();`,
        { transaction },
      );

      await queryInterface.sequelize.query(createRealTransactionsViewSql, { transaction });
    });
  },

  down: async (queryInterface: QueryInterface): Promise<void> => {
    await queryInterface.sequelize.transaction(async (transaction) => {
      await queryInterface.sequelize.query(
        'DROP TRIGGER IF EXISTS expensify_expense_review_on_transaction_delete ON "Transactions";',
        { transaction },
      );
      await queryInterface.sequelize.query(
        'DROP FUNCTION IF EXISTS mark_expensify_expense_review_on_transaction_delete();',
        { transaction },
      );
      await queryInterface.dropTable('ExpensifyMatchCandidates', { transaction });
      await queryInterface.dropTable('ExpensifyExpenses', { transaction });
      await queryInterface.dropTable('ExpensifyConnections', { transaction });

      await queryInterface.sequelize.query(dropRealTransactionsViewSql, { transaction });
      await queryInterface.removeColumn('Transactions', 'workExpenseSource', { transaction });
      await queryInterface.removeColumn('Transactions', 'isWorkExpense', { transaction });
      await queryInterface.sequelize.query(createRealTransactionsViewSql, { transaction });
    });
  },
};
