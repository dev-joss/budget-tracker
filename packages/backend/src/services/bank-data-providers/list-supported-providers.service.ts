import { BANK_PROVIDER_TYPE } from '@bt/shared/types';
import { bankProviderRegistry } from '@services/bank-data-providers';

import { readPlaidConfig } from './plaid/config';

export const listSupportedProviders = () => {
  const providers = bankProviderRegistry.listAll();

  return providers.filter((provider) => provider.type !== BANK_PROVIDER_TYPE.PLAID || readPlaidConfig() !== null);
};
