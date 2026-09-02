import {
  EXPENSIFY_CONFIRMATION_TIERS,
  EXPENSIFY_MATCH_STATES,
  EXPENSIFY_REPORT_STATES,
  type ExpensifyConfirmationTier,
  type ExpensifyMatchState,
  type ExpensifyReportState,
  type ExpensifyReviewReason,
  type RecordId,
} from '@bt/shared/types';
import { IdColumn } from '@common/types/id-column';
import { Money } from '@common/types/money';
import { MoneyField } from '@common/types/money-column';
import Currencies from '@models/currencies.model';
import Transactions from '@models/transactions.model';
import Users from '@models/users.model';
import { BelongsTo, Column, DataType, ForeignKey, Index, Model, Table } from 'sequelize-typescript';

@Table({
  tableName: 'ExpensifyExpenses',
  freezeTableName: true,
  timestamps: true,
})
export default class ExpensifyExpenses extends Model {
  @Column(IdColumn())
  declare id: RecordId;

  @ForeignKey(() => Users)
  @Column({ type: DataType.INTEGER, allowNull: false })
  userId!: number;

  @Column({ type: DataType.STRING(255), allowNull: false })
  externalExpenseId!: string;

  @Column({ type: DataType.STRING(255), allowNull: false })
  externalReportId!: string;

  @Column({
    type: DataType.STRING(30),
    allowNull: false,
    validate: { isIn: [Object.values(EXPENSIFY_REPORT_STATES)] },
  })
  reportState!: ExpensifyReportState;

  @MoneyField({ storage: 'cents' })
  declare originalAmount: Money;

  @ForeignKey(() => Currencies)
  @Column({ type: DataType.STRING(3), allowNull: false })
  originalCurrencyCode!: string;

  @Column({ type: DataType.DATEONLY, allowNull: false })
  expenseDate!: string;

  @Column({ type: DataType.TEXT, allowNull: false })
  originalMerchant!: string;

  @Column({ type: DataType.TEXT, allowNull: true, defaultValue: null })
  modifiedMerchant!: string | null;

  @Column({ type: DataType.BOOLEAN, allowNull: false })
  isReimbursable!: boolean;

  @Column({ type: DataType.STRING(64), allowNull: false })
  upstreamFingerprint!: string;

  @Column({ type: DataType.UUID, allowNull: false })
  lastSeenSynchronizationId!: RecordId;

  @Column({ type: DataType.DATE, allowNull: false })
  lastSeenAt!: Date;

  @Column({
    type: DataType.STRING(20),
    allowNull: false,
    defaultValue: EXPENSIFY_MATCH_STATES.unmatched,
    validate: { isIn: [Object.values(EXPENSIFY_MATCH_STATES)] },
  })
  matchState!: ExpensifyMatchState;

  @ForeignKey(() => Transactions)
  @Index({ name: 'expensify_expenses_linked_transaction_unique', unique: true })
  @Column({ type: DataType.UUID, allowNull: true, defaultValue: null })
  linkedTransactionId!: RecordId | null;

  @Column({
    type: DataType.STRING(20),
    allowNull: true,
    defaultValue: null,
    validate: { isIn: [Object.values(EXPENSIFY_CONFIRMATION_TIERS)] },
  })
  confirmationTier!: ExpensifyConfirmationTier | null;

  @Column({ type: DataType.DATE, allowNull: true, defaultValue: null })
  confirmedAt!: Date | null;

  @Column({ type: DataType.STRING(64), allowNull: true, defaultValue: null })
  confirmationFingerprint!: string | null;

  @Column({ type: DataType.JSONB, allowNull: false, defaultValue: [] })
  reviewReasons!: ExpensifyReviewReason[];

  @Column({ type: DataType.JSONB, allowNull: true, defaultValue: null })
  reviewBaseline!: Record<string, unknown> | null;

  declare createdAt: Date;
  declare updatedAt: Date;

  @BelongsTo(() => Users)
  user!: Users;

  @BelongsTo(() => Transactions, { foreignKey: 'linkedTransactionId', onDelete: 'SET NULL' })
  linkedTransaction!: Transactions | null;

  @BelongsTo(() => Currencies, 'originalCurrencyCode')
  originalCurrency!: Currencies;
}
