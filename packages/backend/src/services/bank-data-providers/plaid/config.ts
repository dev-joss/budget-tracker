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
