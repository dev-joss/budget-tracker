import { DataTypes, type QueryInterface } from 'sequelize';

const INDEX_NAME = 'bank_data_provider_connections_plaid_item_unique';

module.exports = {
  up: async (queryInterface: QueryInterface): Promise<void> => {
    await queryInterface.sequelize.transaction(async (transaction) => {
      await queryInterface.sequelize.query(
        `CREATE UNIQUE INDEX "${INDEX_NAME}"
         ON "BankDataProviderConnections" ("userId", (metadata->>'itemId'))
         WHERE "providerType" = 'plaid'`,
        { transaction },
      );
      await queryInterface.createTable(
        'PlaidConfigurations',
        {
          id: { type: DataTypes.INTEGER, primaryKey: true, allowNull: false },
          encryptedConfiguration: { type: DataTypes.TEXT, allowNull: false },
          createdAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
          updatedAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
        },
        { transaction },
      );
    });
  },

  down: async (queryInterface: QueryInterface): Promise<void> => {
    await queryInterface.sequelize.transaction(async (transaction) => {
      await queryInterface.sequelize.query('DROP TABLE IF EXISTS "PlaidConfigurations"', { transaction });
      await queryInterface.removeIndex('BankDataProviderConnections', INDEX_NAME, { transaction });
    });
  },
};
