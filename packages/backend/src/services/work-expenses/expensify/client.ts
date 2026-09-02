import {
  EXPENSIFY_ELIGIBLE_REPORT_STATES,
  EXPENSIFY_REPORT_STATES,
  EXPENSIFY_SAFE_ERROR_CODES,
  type ExpensifyReportState,
  type ExpensifySafeErrorCode,
} from '@bt/shared/types';
import axios from 'axios';
import Bottleneck from 'bottleneck';
import { z } from 'zod';

import { EXPENSIFY_EXPORT_TEMPLATE } from './template';

export const EXPENSIFY_INTEGRATION_URL = 'https://integrations.expensify.com/Integration-Server/ExpensifyIntegrations';

const REQUEST_TIMEOUT_MS = 20_000;
const MAX_FILENAME_LENGTH = 160;
const MAX_ERROR_ENVELOPE_BYTES = 1_024;
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;
export const MAX_EXPENSES_PER_EXPORT = 10_000;
const MAX_RETRY_ATTEMPTS = 3;
const MAX_AMOUNT_CENTS = 9_000_000_000_000;
const EXPENSIFY_REQUEST_INTERVAL_MS = 3_200;
const RATE_LIMIT_RETRY_BASE_MS = 10_000;
const RETRY_AFTER_MAX_MS = 60_000;
const ELIGIBLE_REPORT_STATES = EXPENSIFY_ELIGIBLE_REPORT_STATES.join(',');

const expensifyRequestLimiter = new Bottleneck({
  maxConcurrent: 1,
  minTime: EXPENSIFY_REQUEST_INTERVAL_MS,
});

export interface ExpensifyCredentials {
  partnerUserId: string;
  partnerUserSecret: string;
}

export interface ExpensifyUpstreamExpense {
  externalReportId: string;
  reportState: ExpensifyReportState;
  externalExpenseId: string;
  originalAmountCents: number;
  originalCurrencyCode: string;
  expenseDate: string;
  originalMerchant: string;
  modifiedMerchant: string | null;
  isReimbursable: boolean;
}

const amountCentsSchema = z
  .union([z.number(), z.string().regex(/^\d+$/)])
  .transform((value) => (typeof value === 'number' ? value : Number(value)))
  .pipe(z.number().int().nonnegative().max(MAX_AMOUNT_CENTS));

const upstreamExpenseSchema = z
  .object({
    externalReportId: z.string().min(1).max(255),
    reportState: z.enum([
      EXPENSIFY_REPORT_STATES.open,
      EXPENSIFY_REPORT_STATES.submitted,
      EXPENSIFY_REPORT_STATES.approved,
      EXPENSIFY_REPORT_STATES.reimbursed,
      EXPENSIFY_REPORT_STATES.archived,
    ]),
    externalExpenseId: z.string().min(1).max(255),
    originalAmount: amountCentsSchema,
    originalCurrencyCode: z.string().regex(/^[A-Z]{3}$/),
    expenseDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    originalMerchant: z.string().max(2_000),
    modifiedMerchant: z.string().max(2_000).nullable(),
    isReimbursable: z.boolean(),
  })
  .strict();

const upstreamExportSchema = z.array(upstreamExpenseSchema).max(MAX_EXPENSES_PER_EXPORT);

const expensifyErrorEnvelopeSchema = z
  .object({
    responseMessage: z.string().min(1).max(MAX_FILENAME_LENGTH),
    responseCode: z.number().int().min(100).max(599),
  })
  .strict();

export class ExpensifyClientError extends Error {
  readonly code: ExpensifySafeErrorCode;

  constructor({ code }: { code: ExpensifySafeErrorCode }) {
    super(code);
    this.name = 'ExpensifyClientError';
    this.code = code;
  }
}

export function parseExpensifyExport({ body }: { body: unknown }): ExpensifyUpstreamExpense[] {
  if (typeof body !== 'string' || Buffer.byteLength(body, 'utf8') > MAX_RESPONSE_BYTES) {
    throw new ExpensifyClientError({ code: EXPENSIFY_SAFE_ERROR_CODES.invalidResponse });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new ExpensifyClientError({ code: EXPENSIFY_SAFE_ERROR_CODES.invalidResponse });
  }

  const validated = upstreamExportSchema.safeParse(parsed);
  if (!validated.success) {
    throw new ExpensifyClientError({ code: EXPENSIFY_SAFE_ERROR_CODES.invalidResponse });
  }

  return validated.data.map(({ originalAmount, ...expense }) => ({
    ...expense,
    originalAmountCents: originalAmount,
  }));
}

function expensifyResponseErrorCode({ body }: { body: string }): ExpensifySafeErrorCode | null {
  if (Buffer.byteLength(body, 'utf8') > MAX_ERROR_ENVELOPE_BYTES) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }

  const envelope = expensifyErrorEnvelopeSchema.safeParse(parsed);
  if (!envelope.success) return null;
  return envelope.data.responseMessage === 'Authentication error' ? EXPENSIFY_SAFE_ERROR_CODES.authentication : null;
}

function safeErrorCode({ error }: { error: unknown }): ExpensifySafeErrorCode {
  if (error instanceof ExpensifyClientError) return error.code;
  if (!axios.isAxiosError(error)) return EXPENSIFY_SAFE_ERROR_CODES.unavailable;

  const status = error.response?.status;
  if (status === 429) return EXPENSIFY_SAFE_ERROR_CODES.rateLimited;
  if (status === 400 || status === 401 || status === 403) return EXPENSIFY_SAFE_ERROR_CODES.authentication;
  if (status !== undefined && status >= 500) return EXPENSIFY_SAFE_ERROR_CODES.unavailable;
  return EXPENSIFY_SAFE_ERROR_CODES.unavailable;
}

export function isRetryableExpensifyError({ error }: { error: unknown }): boolean {
  if (!axios.isAxiosError(error)) return false;
  if (!error.response) return true;
  return error.response.status === 429 || error.response.status >= 500;
}

const wait = ({ milliseconds }: { milliseconds: number }): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

function retryAfterMilliseconds({ error }: { error: unknown }): number | undefined {
  if (!axios.isAxiosError(error) || error.response?.status !== 429) return undefined;

  const rawHeader = error.response.headers?.['retry-after'];
  const header = Array.isArray(rawHeader) ? rawHeader[0] : rawHeader;
  if (typeof header !== 'string' && typeof header !== 'number') return undefined;

  const value = String(header).trim();
  const delay = /^\d+(?:\.\d+)?$/.test(value) ? Number(value) * 1_000 : Date.parse(value) - Date.now();
  if (!Number.isFinite(delay) || delay <= 0) return undefined;
  return Math.min(Math.ceil(delay), RETRY_AFTER_MAX_MS);
}

function retryDelayMilliseconds({ error, attempt }: { error: unknown; attempt: number }): number {
  const isRateLimited = axios.isAxiosError(error) && error.response?.status === 429;
  const baseDelay = (isRateLimited ? RATE_LIMIT_RETRY_BASE_MS : 500) * 2 ** attempt;
  const retryAfter = retryAfterMilliseconds({ error }) ?? 0;
  return Math.max(EXPENSIFY_REQUEST_INTERVAL_MS, baseDelay, retryAfter) + Math.floor(Math.random() * 100);
}

async function withRetry<T>({ request }: { request: () => Promise<T> }): Promise<T> {
  return expensifyRequestLimiter.schedule(async () => {
    let lastError: unknown;
    for (let attempt = 0; attempt < MAX_RETRY_ATTEMPTS; attempt += 1) {
      try {
        return await request();
      } catch (error) {
        lastError = error;
        if (!isRetryableExpensifyError({ error }) || attempt === MAX_RETRY_ATTEMPTS - 1) break;
        await wait({ milliseconds: retryDelayMilliseconds({ error, attempt }) });
      }
    }
    throw new ExpensifyClientError({ code: safeErrorCode({ error: lastError }) });
  });
}

const connectionTails = new Map<string, Promise<void>>();

async function serializeConnectionCall<T>({ connectionKey, fn }: { connectionKey: string; fn: () => Promise<T> }) {
  const prior = connectionTails.get(connectionKey) ?? Promise.resolve();
  const result = prior.then(fn, fn);
  const tail = result.then(
    () => undefined,
    () => undefined,
  );
  connectionTails.set(connectionKey, tail);
  try {
    return await result;
  } finally {
    if (connectionTails.get(connectionKey) === tail) connectionTails.delete(connectionKey);
  }
}

export function buildExporterDescription({
  credentials,
  startDate,
  endDate,
  reportIds,
  eligibleStatesOnly,
}: {
  credentials: ExpensifyCredentials;
  startDate?: string;
  endDate?: string;
  reportIds?: string[];
  eligibleStatesOnly: boolean;
}) {
  return {
    type: 'file',
    credentials: {
      partnerUserID: credentials.partnerUserId,
      partnerUserSecret: credentials.partnerUserSecret,
    },
    onReceive: { immediateResponse: ['returnRandomFileName'] },
    inputSettings: {
      type: 'combinedReportData',
      ...(eligibleStatesOnly ? { reportState: ELIGIBLE_REPORT_STATES } : {}),
      filters: {
        ...(startDate ? { startDate } : {}),
        ...(endDate ? { endDate } : {}),
        ...(reportIds?.length ? { reportIDList: reportIds.join(',') } : {}),
      },
    },
    outputSettings: { fileExtension: 'json' },
  };
}

async function requestFilename({
  credentials,
  startDate,
  endDate,
  reportIds,
  eligibleStatesOnly,
}: {
  credentials: ExpensifyCredentials;
  startDate?: string;
  endDate?: string;
  reportIds?: string[];
  eligibleStatesOnly: boolean;
}): Promise<string> {
  const form = new URLSearchParams({
    requestJobDescription: JSON.stringify(
      buildExporterDescription({ credentials, startDate, endDate, reportIds, eligibleStatesOnly }),
    ),
    template: EXPENSIFY_EXPORT_TEMPLATE,
  });

  const response = await withRetry({
    request: () =>
      axios.post<string>(EXPENSIFY_INTEGRATION_URL, form, {
        timeout: REQUEST_TIMEOUT_MS,
        responseType: 'text',
        maxContentLength: MAX_FILENAME_LENGTH,
        maxBodyLength: 128 * 1024,
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
      }),
  });

  const filename = String(response.data).trim();
  const responseErrorCode = expensifyResponseErrorCode({ body: filename });
  if (responseErrorCode) throw new ExpensifyClientError({ code: responseErrorCode });
  if (!filename || filename.length > MAX_FILENAME_LENGTH || !/^[A-Za-z0-9._-]+$/.test(filename)) {
    throw new ExpensifyClientError({ code: EXPENSIFY_SAFE_ERROR_CODES.invalidResponse });
  }
  return filename;
}

async function downloadExport({
  credentials,
  filename,
}: {
  credentials: ExpensifyCredentials;
  filename: string;
}): Promise<string> {
  const form = new URLSearchParams({
    requestJobDescription: JSON.stringify({
      type: 'download',
      credentials: {
        partnerUserID: credentials.partnerUserId,
        partnerUserSecret: credentials.partnerUserSecret,
      },
      fileName: filename,
      fileSystem: 'integrationServer',
    }),
  });

  const response = await withRetry({
    request: () =>
      axios.post<string>(EXPENSIFY_INTEGRATION_URL, form, {
        timeout: REQUEST_TIMEOUT_MS,
        responseType: 'text',
        maxContentLength: MAX_RESPONSE_BYTES,
        maxBodyLength: 32 * 1024,
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
      }),
  });
  const body = String(response.data);
  const responseErrorCode = expensifyResponseErrorCode({ body });
  if (responseErrorCode) throw new ExpensifyClientError({ code: responseErrorCode });
  return body;
}

export async function exportExpensifyExpenses({
  connectionKey,
  credentials,
  startDate,
  endDate,
  reportIds,
  eligibleStatesOnly = true,
}: {
  connectionKey: string;
  credentials: ExpensifyCredentials;
  startDate?: string;
  endDate?: string;
  reportIds?: string[];
  eligibleStatesOnly?: boolean;
}): Promise<ExpensifyUpstreamExpense[]> {
  return serializeConnectionCall({
    connectionKey,
    fn: async () => {
      try {
        const filename = await requestFilename({
          credentials,
          startDate,
          endDate,
          reportIds,
          eligibleStatesOnly,
        });
        const body = await downloadExport({ credentials, filename });
        return parseExpensifyExport({ body });
      } catch (error) {
        if (error instanceof ExpensifyClientError) throw error;
        throw new ExpensifyClientError({ code: safeErrorCode({ error }) });
      }
    },
  });
}
