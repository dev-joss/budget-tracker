import type { RecordId } from '@bt/shared/types';
import { IdColumn } from '@common/types/id-column';
import ExpensifyExpenses from '@models/expensify-expenses.model';
import Transactions from '@models/transactions.model';
import Users from '@models/users.model';
import { BelongsTo, Column, DataType, ForeignKey, Model, Table } from 'sequelize-typescript';

@Table({
  tableName: 'ExpensifyMatchCandidates',
  freezeTableName: true,
  timestamps: false,
  indexes: [
    {
      name: 'expensify_match_candidates_expense_transaction_unique',
      fields: ['expenseId', 'transactionId'],
      unique: true,
    },
    {
      name: 'expensify_match_candidates_transaction_id',
      fields: ['transactionId'],
    },
    {
      name: 'expensify_match_candidates_user_expense_rank',
      fields: ['userId', 'expenseId', 'rank'],
    },
  ],
})
export default class ExpensifyMatchCandidates extends Model {
  @Column(IdColumn())
  declare id: RecordId;

  @ForeignKey(() => Users)
  @Column({ type: DataType.INTEGER, allowNull: false })
  userId!: number;

  @ForeignKey(() => ExpensifyExpenses)
  @Column({ type: DataType.UUID, allowNull: false })
  expenseId!: RecordId;

  @ForeignKey(() => Transactions)
  @Column({ type: DataType.UUID, allowNull: false })
  transactionId!: RecordId;

  @Column({ type: DataType.INTEGER, allowNull: false })
  rank!: number;

  @Column({ type: DataType.SMALLINT, allowNull: false })
  compositeScoreBps!: number;

  @Column({ type: DataType.SMALLINT, allowNull: false })
  merchantSimilarityBps!: number;

  @Column({ type: DataType.SMALLINT, allowNull: false })
  dateDistance!: number;

  @Column({ type: DataType.BOOLEAN, allowNull: false, defaultValue: false })
  isReciprocalTop!: boolean;

  @BelongsTo(() => Users)
  user!: Users;

  @BelongsTo(() => ExpensifyExpenses, { foreignKey: 'expenseId', onDelete: 'CASCADE' })
  expense!: ExpensifyExpenses;

  @BelongsTo(() => Transactions, { foreignKey: 'transactionId', onDelete: 'CASCADE' })
  transaction!: Transactions;
}
