import type { RecordId } from '@bt/shared/types';
import { IdColumn } from '@common/types/id-column';
import Users from '@models/users.model';
import { BelongsTo, Column, DataType, ForeignKey, Index, Model, Table } from 'sequelize-typescript';

@Table({
  tableName: 'ExpensifyConnections',
  freezeTableName: true,
  timestamps: true,
  defaultScope: {
    attributes: { exclude: ['encryptedCredentials', 'activeSynchronizationRunId'] },
  },
})
export default class ExpensifyConnections extends Model {
  @Column(IdColumn())
  declare id: RecordId;

  @ForeignKey(() => Users)
  @Index({ name: 'expensify_connections_user_id_unique', unique: true })
  @Column({ type: DataType.INTEGER, allowNull: false })
  userId!: number;

  @Column({ type: DataType.TEXT, allowNull: true, defaultValue: null })
  encryptedCredentials!: string | null;

  @Column({ type: DataType.DATEONLY, allowNull: false })
  initialSyncDate!: string;

  @Column({ type: DataType.INTEGER, allowNull: false, defaultValue: 1 })
  credentialRevision!: number;

  @Column({ type: DataType.UUID, allowNull: true, defaultValue: null })
  activeSynchronizationRunId!: RecordId | null;

  @Column({ type: DataType.DATE, allowNull: true, defaultValue: null })
  lastAttemptedSyncAt!: Date | null;

  @Column({ type: DataType.DATE, allowNull: true, defaultValue: null })
  lastSuccessfulSyncAt!: Date | null;

  @Column({ type: DataType.STRING(50), allowNull: true, defaultValue: null })
  lastErrorCode!: string | null;

  declare createdAt: Date;
  declare updatedAt: Date;

  @BelongsTo(() => Users)
  user!: Users;
}
