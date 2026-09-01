import type { QueryInterface } from 'sequelize';

const INDEX_NAME = 'bank_data_provider_connections_plaid_item_unique';

module.exports = {
  up: async (queryInterface: QueryInterface): Promise<void> => {
    await queryInterface.sequelize.query(
      `CREATE UNIQUE INDEX "${INDEX_NAME}"
       ON "BankDataProviderConnections" ("userId", (metadata->>'itemId'))
       WHERE "providerType" = 'plaid'`,
    );
  },

  down: async (queryInterface: QueryInterface): Promise<void> => {
    await queryInterface.removeIndex('BankDataProviderConnections', INDEX_NAME);
  },
};
