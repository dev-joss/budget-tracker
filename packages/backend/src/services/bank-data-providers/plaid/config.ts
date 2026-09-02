import { t } from '@i18n/index';
import { ValidationError } from '@js/errors';
import PlaidConfigurations from '@models/plaid-configurations.model';
import { decryptCredentials, encryptCredentials } from '@services/bank-data-providers/utils/credential-encryption';
import { withTransaction } from '@services/common/with-transaction';
import { CountryCode, PlaidEnvironments } from 'plaid';
import { z } from 'zod';

const httpsUrl = z
  .string()
  .url()
  .refine((value) => new URL(value).protocol === 'https:', 'Must use HTTPS');

const environmentSchema = z.object({
  PLAID_CLIENT_ID: z.string().min(1),
  PLAID_SECRET: z.string().min(1),
  PLAID_ENV: z.enum(['sandbox', 'production']),
  PLAID_COUNTRY_CODES: z.string().default('US,CA'),
  PLAID_REDIRECT_URI: z.string().url().optional(),
  PLAID_WEBHOOK_URL: z.string().url().optional(),
  PLAID_TRANSACTIONS_DAYS_REQUESTED: z.coerce.number().int().min(90).max(730).default(180),
});

export interface PlaidConfig {
  clientId: string;
  secret: string;
  environment: 'sandbox' | 'production';
  basePath: string;
  countryCodes: CountryCode[];
  redirectUri?: string;
  webhookUrl?: string;
  transactionsDaysRequested: number;
}

export interface PlaidConfigurationInput {
  clientId: string;
  secret?: string;
  environment: 'sandbox' | 'production';
  countryCodes: string[];
  transactionsDaysRequested: number;
}

export interface PlaidConfigurationView {
  configured: true;
  secretConfigured: true;
  clientId: string;
  environment: 'sandbox' | 'production';
  countryCodes: string[];
  transactionsDaysRequested: number;
}

interface StoredPlaidConfiguration extends PlaidConfigurationInput {
  secret: string;
}

const supportedCountryCodes = new Set(Object.values(CountryCode));

export const readPlaidConfig = ({ env = process.env }: { env?: NodeJS.ProcessEnv } = {}): PlaidConfig | null => {
  const configuredValues = ['PLAID_CLIENT_ID', 'PLAID_SECRET', 'PLAID_ENV'].filter((key) => env[key]);
  if (configuredValues.length === 0) return null;

  const parsed = environmentSchema.parse(env);
  const countryCodes = parsed.PLAID_COUNTRY_CODES.split(',').map((value) => value.trim().toUpperCase());
  if (countryCodes.length === 0 || countryCodes.some((value) => !supportedCountryCodes.has(value as CountryCode))) {
    throw new Error('PLAID_COUNTRY_CODES contains an unsupported country code');
  }

  if (parsed.PLAID_ENV === 'production') {
    if (parsed.PLAID_REDIRECT_URI) httpsUrl.parse(parsed.PLAID_REDIRECT_URI);
    if (parsed.PLAID_WEBHOOK_URL) httpsUrl.parse(parsed.PLAID_WEBHOOK_URL);
  }

  return {
    clientId: parsed.PLAID_CLIENT_ID,
    secret: parsed.PLAID_SECRET,
    environment: parsed.PLAID_ENV,
    basePath: PlaidEnvironments[parsed.PLAID_ENV]!,
    countryCodes: countryCodes as CountryCode[],
    redirectUri: parsed.PLAID_REDIRECT_URI,
    webhookUrl: parsed.PLAID_WEBHOOK_URL,
    transactionsDaysRequested: parsed.PLAID_TRANSACTIONS_DAYS_REQUESTED,
  };
};

const readStoredConfiguration = async (): Promise<StoredPlaidConfiguration | null> => {
  const row = await PlaidConfigurations.findByPk(1);
  if (!row) return null;
  return decryptCredentials(row.encryptedConfiguration) as unknown as StoredPlaidConfiguration;
};

const storedConfigurationToEnvironment = ({
  configuration,
  env,
}: {
  configuration: StoredPlaidConfiguration;
  env: NodeJS.ProcessEnv;
}): NodeJS.ProcessEnv => ({
  ...env,
  PLAID_CLIENT_ID: configuration.clientId,
  PLAID_SECRET: configuration.secret,
  PLAID_ENV: configuration.environment,
  PLAID_COUNTRY_CODES: configuration.countryCodes.join(','),
  PLAID_TRANSACTIONS_DAYS_REQUESTED: String(configuration.transactionsDaysRequested),
});

export const resolvePlaidConfig = async ({
  env = process.env,
}: {
  env?: NodeJS.ProcessEnv;
} = {}): Promise<PlaidConfig | null> => {
  const stored = await readStoredConfiguration();
  return readPlaidConfig({ env: stored ? storedConfigurationToEnvironment({ configuration: stored, env }) : env });
};

export const getPlaidConfiguration = async (): Promise<PlaidConfigurationView | null> => {
  const config = await resolvePlaidConfig();
  if (!config) return null;
  return {
    configured: true,
    secretConfigured: true,
    clientId: config.clientId,
    environment: config.environment,
    countryCodes: config.countryCodes,
    transactionsDaysRequested: config.transactionsDaysRequested,
  };
};

const savePlaidConfigurationImpl = async ({
  input,
}: {
  input: PlaidConfigurationInput;
}): Promise<PlaidConfigurationView> => {
  const current = await resolvePlaidConfig();
  const secret = input.secret?.trim() || current?.secret;
  if (!secret) throw new ValidationError({ message: t({ key: 'bankDataProviders.plaid.secretRequired' }) });

  const stored: StoredPlaidConfiguration = { ...input, clientId: input.clientId.trim(), secret };
  const parsed = readPlaidConfig({
    env: storedConfigurationToEnvironment({ configuration: stored, env: process.env }),
  });
  if (!parsed) throw new ValidationError({ message: t({ key: 'bankDataProviders.plaid.notConfigured' }) });

  await PlaidConfigurations.upsert({
    id: 1,
    encryptedConfiguration: encryptCredentials({ ...stored }),
  });
  return {
    configured: true,
    secretConfigured: true,
    clientId: parsed.clientId,
    environment: parsed.environment,
    countryCodes: parsed.countryCodes,
    transactionsDaysRequested: parsed.transactionsDaysRequested,
  };
};

export const savePlaidConfiguration = withTransaction(savePlaidConfigurationImpl);
