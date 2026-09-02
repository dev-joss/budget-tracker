import { EXPENSIFY_SAFE_ERROR_CODES } from '@bt/shared/types';
import { describe, expect, it, jest } from '@jest/globals';
import axios from 'axios';
import fs from 'node:fs';
import path from 'node:path';

import { buildExporterDescription, exportExpensifyExpenses, parseExpensifyExport } from './client';
import { EXPENSIFY_EXPORT_TEMPLATE } from './template';

const fixture = ({ name }: { name: string }) => fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8');

describe('Expensify exporter contract', () => {
  it('keeps the template static and JSON-escapes every string field', () => {
    expect(EXPENSIFY_EXPORT_TEMPLATE).toContain('?json_string');
    expect(EXPENSIFY_EXPORT_TEMPLATE).not.toContain('partnerUser');
    expect(EXPENSIFY_EXPORT_TEMPLATE).not.toContain('onFinish');
  });

  it('maps every supported report status to the API report state', () => {
    expect(EXPENSIFY_EXPORT_TEMPLATE).toContain('"Open":"OPEN"');
    expect(EXPENSIFY_EXPORT_TEMPLATE).toContain('"Processing":"SUBMITTED"');
    expect(EXPENSIFY_EXPORT_TEMPLATE).toContain('"Approved":"APPROVED"');
    expect(EXPENSIFY_EXPORT_TEMPLATE).toContain('"Reimbursed":"REIMBURSED"');
    expect(EXPENSIFY_EXPORT_TEMPLATE).toContain('"Archived":"ARCHIVED"');
    expect(EXPENSIFY_EXPORT_TEMPLATE).toContain('reportStateByStatus[report.status]');
    expect(EXPENSIFY_EXPORT_TEMPLATE).not.toContain('${report.state');
  });

  it('builds the documented exporter request shape', () => {
    const description = buildExporterDescription({
      credentials: {
        partnerUserId: 'fixture-user',
        partnerUserSecret: 'fixture-secret',
      },
      startDate: '2026-01-01',
      endDate: '2026-01-31',
      reportIds: ['R-1', 'R-2'],
      eligibleStatesOnly: true,
    });

    expect(description).toEqual(JSON.parse(fixture({ name: 'exporter-request-job-description.json' })));
    expect(description.inputSettings).toHaveProperty('reportState');
    expect(description.inputSettings.filters).not.toHaveProperty('reportState');
  });

  it('accepts empty output', () => {
    expect(parseExpensifyExport({ body: fixture({ name: 'empty.json' }) })).toEqual([]);
  });

  it('parses escaped and modified merchant values without changing cents', () => {
    const [expense] = parseExpensifyExport({ body: fixture({ name: 'escaped-and-modified.json' }) });
    expect(expense).toMatchObject({
      originalAmountCents: 12345,
      originalMerchant: 'A "quoted" merchant\nline two',
      modifiedMerchant: 'Merchant & Co.',
    });
  });

  it('maps malformed output to the safe invalid-response code', () => {
    expect.assertions(1);
    try {
      parseExpensifyExport({ body: fixture({ name: 'malformed.json' }) });
    } catch (error) {
      expect(error).toMatchObject({
        code: EXPENSIFY_SAFE_ERROR_CODES.invalidResponse,
      });
    }
  });

  it('maps Expensify HTTP-200 authentication errors to the authentication code', async () => {
    const postSpy = jest.spyOn(axios, 'post').mockResolvedValueOnce({
      data: JSON.stringify({ responseMessage: 'Authentication error', responseCode: 404 }),
      status: 200,
    } as never);

    try {
      await expect(
        exportExpensifyExpenses({
          connectionKey: 'authentication-error-test',
          credentials: { partnerUserId: 'invalid-user', partnerUserSecret: 'invalid-secret' },
          startDate: '2026-08-25',
          endDate: '2026-09-01',
        }),
      ).rejects.toMatchObject({ code: EXPENSIFY_SAFE_ERROR_CODES.authentication });
    } finally {
      postSpy.mockRestore();
    }
  });

  it('maps downloader HTTP-200 authentication errors to the authentication code', async () => {
    const postSpy = jest
      .spyOn(axios, 'post')
      .mockResolvedValueOnce({ data: 'export-file.json', status: 200 } as never)
      .mockResolvedValueOnce({
        data: JSON.stringify({ responseMessage: 'Authentication error', responseCode: 404 }),
        status: 200,
      } as never);

    try {
      await expect(
        exportExpensifyExpenses({
          connectionKey: 'download-authentication-error-test',
          credentials: { partnerUserId: 'invalid-user', partnerUserSecret: 'invalid-secret' },
          startDate: '2026-08-25',
          endDate: '2026-09-01',
        }),
      ).rejects.toMatchObject({ code: EXPENSIFY_SAFE_ERROR_CODES.authentication });
    } finally {
      postSpy.mockRestore();
    }
  }, 10_000);
});
