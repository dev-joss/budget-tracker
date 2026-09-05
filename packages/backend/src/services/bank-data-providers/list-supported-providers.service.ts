import { BANK_PROVIDER_TYPE } from '@bt/shared/types';
import { bankProviderRegistry } from '@services/bank-data-providers';

import { resolvePlaidConfig } from './plaid/config';

export const listSupportedProviders = async () => {
  const providers = bankProviderRegistry.listAll();
  const plaidConfig = await resolvePlaidConfig();

  return providers.filter((provider) => provider.type !== BANK_PROVIDER_TYPE.PLAID || plaidConfig !== null);
};
