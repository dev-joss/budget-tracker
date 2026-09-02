import { Column, DataType, Model, Table } from 'sequelize-typescript';

@Table({
  tableName: 'PlaidConfigurations',
  timestamps: true,
  freezeTableName: true,
})
export default class PlaidConfigurations extends Model {
  @Column({
    type: DataType.INTEGER,
    primaryKey: true,
    allowNull: false,
  })
  declare id: number;

  @Column({
    type: DataType.TEXT,
    allowNull: false,
  })
  encryptedConfiguration!: string;

  declare createdAt: Date;
  declare updatedAt: Date;
}
