// key_figures (#66): sums per key figure code, no account-level data, and
// report_data's totals per year or period.
import { describe, expect, it } from 'vitest';
import { createEconomicGateway, resolveEconomicReadTarget, type GatewayJsonObject } from '../src/gateway.js';

const context = { credentials: { agreementGrantToken: 'grant-token-for-tests' } };

const years = {
  collection: [
    { year: '2025', fromDate: '2025-01-01', toDate: '2025-12-31', self: 'https://restapi.e-conomic.com/accounting-years/2025' },
    { year: '2026', fromDate: '2026-01-01', toDate: '2026-12-31', self: 'https://restapi.e-conomic.com/accounting-years/2026' },
  ],
  pagination: { results: 2 },
};

// Accounts with their key figure codes: 1 turnover, 2 variable costs, 5 overheads, 9 tax, 12 customers, 14 cash, 20 suppliers.
const openApiAccounts = {
  items: [
    { number: 1010, keyFigureCodeNumber: 1 },
    { number: 1020, keyFigureCodeNumber: 1 },
    { number: 1310, keyFigureCodeNumber: 2 },
    { number: 2210, keyFigureCodeNumber: 5 },
    { number: 3610, keyFigureCodeNumber: 9 },
    { number: 5600, keyFigureCodeNumber: 12 },
    { number: 5820, keyFigureCodeNumber: 14 },
    { number: 6800, keyFigureCodeNumber: 20 },
    { number: 6902 },
  ],
  cursor: null,
};

const codes = {
  items: [
    { number: 1, isBalance: false }, { number: 2, isBalance: false }, { number: 5, isBalance: false }, { number: 9, isBalance: false },
    { number: 12, isBalance: true }, { number: 14, isBalance: true }, { number: 20, isBalance: true },
  ],
};

const total = (account: number, amount: number, from = '2026-01-01', to = '2026-12-31') => ({
  account: { accountNumber: account },
  totalInBaseCurrency: amount,
  fromDate: from,
  toDate: to,
});

function fakeEconomic() {
  const paths: string[] = [];
  const gateway = createEconomicGateway({
    appSecretToken: 'app-secret-for-tests',
    fetchImpl: (async (input: string | URL | Request, init?: RequestInit) => {
      const request = new Request(input, init);
      const path = new URL(request.url).pathname;
      paths.push(path);
      if (path === '/accounting-years') return Response.json(years);
      if (path === '/accounting-years/2026/totals') {
        return Response.json({ collection: [total(1010, -10000), total(1020, -2000), total(1310, 4400), total(2210, 5000), total(3610, 600), total(5820, 300)] });
      }
      if (path === '/accounting-years/2026/periods/3/totals') {
        return Response.json({ collection: [total(1010, -1000, '2026-03-01', '2026-03-31'), total(1310, 400, '2026-03-01', '2026-03-31')] });
      }
      if (path === '/accounting-years/2025/totals') return Response.json({ collection: [total(1010, -8000, '2025-01-01', '2025-12-31')] });
      if (path === '/accounting-years/2025/periods/3/totals') return Response.json({ collection: [] });
      if (path.endsWith('/Accounts')) return Response.json(openApiAccounts);
      if (path.endsWith('/KeyFigureCodes')) return Response.json(codes);
      if (path === '/accounts') {
        return Response.json({
          collection: [
            { accountNumber: 5600, balance: 12500 },
            { accountNumber: 5820, balance: 5935.5 },
            { accountNumber: 6800, balance: -2500 },
            { accountNumber: 6902, balance: -1250 },
          ],
        });
      }
      if (path === '/vat-accounts') return Response.json({ collection: [{ vatCode: 'U25', account: { accountNumber: 6902 } }] });
      if (path === '/invoices/totals') {
        return Response.json({
          booked: { unpaid: { grossRemainderInBaseCurrency: 12500, invoiceCount: 3, overdue: { grossRemainderInBaseCurrency: 5000, invoiceCount: 1 } } },
        });
      }
      return new Response('{"message":"not found"}', { status: 404 });
    }) as typeof fetch,
  });
  return { gateway, paths };
}

describe('key_figures', () => {
  it('sums the totals per key figure code, turned to read income positive, with the year before', async () => {
    const { gateway } = fakeEconomic();
    const result = await gateway.callTool('key_figures', { accountingYear: '2026' }, context);
    expect(result.isError, result.content[0]?.text).toBeUndefined();
    expect(result.content[0]?.text.split('\n\n')[0]).toBe('key_figures: accounting year 2026, with the year before.');
    expect(result.structuredContent).toEqual({
      accountingYear: '2026',
      fromDate: '2026-01-01',
      toDate: '2026-12-31',
      currency: 'base currency of the agreement',
      figures: {
        turnover: 12000,
        grossProfit: 7600,
        contributionMargin: 7600,
        resultBeforeDepreciation: 2600,
        operatingResult: 2600,
        resultBeforeTax: 2600,
        result: 2000,
      },
      balancesNow: { cash: 5935.5, receivables: 12500, supplierDebt: 2500, vatOwed: 1250 },
      invoicesNow: { unpaidGross: 12500, unpaidCount: 3, overdueGross: 5000, overdueCount: 1 },
      previousYear: {
        accountingYear: '2025',
        fromDate: '2025-01-01',
        toDate: '2025-12-31',
        figures: {
          turnover: 8000,
          grossProfit: 8000,
          contributionMargin: 8000,
          resultBeforeDepreciation: 8000,
          operatingResult: 8000,
          resultBeforeTax: 8000,
          result: 8000,
        },
      },
    });
  });

  it('answers with sums only: no account number, entry, customer or supplier', async () => {
    const { gateway } = fakeEconomic();
    const result = await gateway.callTool('key_figures', { accountingYear: '2026' }, context);
    const text = JSON.stringify(result.structuredContent);
    for (const account of ['1010', '1020', '1310', '2210', '3610', '5600', '5820', '6800', '6902']) {
      expect(text).not.toContain(account);
    }
    expect(text).not.toMatch(/accountNumber|customer|supplierNumber|entryNumber/);
  });

  it('reads one period of the year and the same period the year before', async () => {
    const { gateway, paths } = fakeEconomic();
    const result = await gateway.callTool('key_figures', { accountingYear: '2026', period: 3 }, context);
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toMatchObject({
      accountingYear: '2026',
      period: 3,
      fromDate: '2026-03-01',
      toDate: '2026-03-31',
      figures: { turnover: 1000, grossProfit: 600 },
      previousYear: { accountingYear: '2025', period: 3, figures: { turnover: 0 } },
    });
    // The period before has no totals: no dates, never the whole year's.
    const previousYear = (result.structuredContent as GatewayJsonObject).previousYear as GatewayJsonObject;
    expect(previousYear).not.toHaveProperty('fromDate');
    expect(previousYear).not.toHaveProperty('toDate');
    expect(paths).toContain('/accounting-years/2026/periods/3/totals');
    expect(paths).toContain('/accounting-years/2025/periods/3/totals');
  });

  it('leaves the year before out when asked, and refuses an unknown year or bad input', async () => {
    const { gateway, paths } = fakeEconomic();
    const alone = await gateway.callTool('key_figures', { accountingYear: '2026', compare: false }, context);
    expect(alone.structuredContent).not.toHaveProperty('previousYear');
    expect(paths).not.toContain('/accounting-years/2025/totals');
    const unknown = await gateway.callTool('key_figures', { accountingYear: '2019' }, context);
    expect(unknown).toMatchObject({ isError: true, content: [{ text: 'There is no accounting year 2019 in e-conomic.' }] });
    for (const input of [{ accountingYear: 'last year' }, { period: 0 }, { period: 1.5 }, { compare: 'yes' }, { accountNumber: 1010 }] as GatewayJsonObject[]) {
      expect(resolveEconomicReadTarget('key_figures', input).ok, JSON.stringify(input)).toBe(false);
    }
  });

  it('names what it reads for the host log, without a year id it cannot know before the call', () => {
    for (const input of [{}, { accountingYear: '2025/2026', period: 3 }] as GatewayJsonObject[]) {
      expect(resolveEconomicReadTarget('key_figures', input)).toEqual({
        ok: true,
        target: { serviceId: 'rest', resource: 'accounting-years', method: 'GET', pathTemplate: '/accounting-years' },
      });
    }
  });

  it('fails instead of answering with incomplete sums when a cursor repeats', async () => {
    const gateway = createEconomicGateway({
      appSecretToken: 'app-secret-for-tests',
      fetchImpl: (async (input: string | URL | Request) => {
        const path = new URL(String(input instanceof Request ? input.url : input)).pathname;
        if (path === '/accounting-years') return Response.json(years);
        if (path.endsWith('/Accounts')) return Response.json({ items: [{ number: 1010, keyFigureCodeNumber: 1 }], cursor: 'same' });
        return Response.json({ collection: [], items: [] });
      }) as typeof fetch,
    });
    const result = await gateway.callTool('key_figures', { accountingYear: '2026' }, context);
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('same cursor twice');
  });
});

describe('report_data totals', () => {
  it('reads the totals per account of a year or a period', async () => {
    const { gateway, paths } = fakeEconomic();
    expect((await gateway.callTool('report_data', { resource: 'accounting-years', number: '2026', totals: true }, context)).isError).toBeUndefined();
    expect((await gateway.callTool('report_data', { resource: 'accounting-years', number: 2026, totals: true, period: 3 }, context)).isError).toBeUndefined();
    expect(paths).toEqual(['/accounting-years/2026/totals', '/accounting-years/2026/periods/3/totals']);
  });

  it('refuses totals on another resource, without a year, or a period without totals', () => {
    for (const input of [
      { resource: 'Accounts', number: 2026, totals: true },
      { resource: 'accounting-years', totals: true },
      { resource: 'accounting-years', number: 2026, period: 3 },
      { resource: 'accounting-years', number: '../self', totals: true },
    ] as GatewayJsonObject[]) {
      expect(resolveEconomicReadTarget('report_data', input).ok, JSON.stringify(input)).toBe(false);
    }
  });
});
