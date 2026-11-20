import { describe, expect, it, vi } from 'vitest';
import {
  createEconomicGateway,
  economicToolCatalog,
  resolveEconomicChange,
  type EconomicHostPolicy,
  type GatewayJsonObject,
} from '../src/gateway.js';
import { assertNoBankChange, bankFieldPaths, changedBankFields } from '../src/economic/bank-fields.js';
import { EconomicClient } from '../src/economic/client.js';
import { basePolicy, checkPolicy } from '../src/economic/policy.js';
import { canonicalEndpointCall } from '../src/economic/endpoints.js';
import { MAX_DRAFT_PAGES, validateBooking } from '../src/economic/bookings.js';

const BOOKING_TOOLS = ['book_journal_entries', 'book_invoice', 'match_open_items'];
const context = { credentials: { agreementGrantToken: 'grant-token-for-tests' } };

type Responder = (request: Request, body: unknown) => Response | undefined;

/** A gateway against a recorded fake e-conomic. `respond` answers a request, or the default does. */
function fakeEconomic(policy: EconomicHostPolicy | undefined, respond: Responder = () => undefined) {
  const requests: Array<{ method: string; path: string; body: unknown }> = [];
  const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(input, init);
    const text = request.method === 'GET' ? '' : await request.text();
    const body = text ? JSON.parse(text) : undefined;
    const path = new URL(request.url).pathname;
    requests.push({ method: request.method, path, body });
    return respond(request, body) ?? defaultResponse(request.method, path);
  });
  const gateway = createEconomicGateway({
    appSecretToken: 'app-secret-for-tests',
    fetchImpl: fetchImpl as unknown as typeof fetch,
    ...(policy ? { policy } : {}),
  });
  return { gateway, requests, writes: () => requests.filter(request => request.method !== 'GET') };
}

const existingSupplier = {
  supplierNumber: 2001,
  name: 'Demo Grossist A/S',
  currency: 'DKK',
  bankAccount: '1234-0001234567',
  remittanceAdvice: { creditorId: '1234-0001234567', paymentType: { paymentTypeNumber: 3 } },
  supplierGroup: { supplierGroupNumber: 1 },
  paymentTerms: { paymentTermsNumber: 1 },
  vatZone: { vatZoneNumber: 1 },
};

function defaultResponse(method: string, path: string): Response {
  if (method === 'GET' && path === '/accounting-years') {
    return Response.json({
      collection: [
        { year: '2025', fromDate: '2025-01-01', toDate: '2025-12-31' },
        { year: '2026', fromDate: '2026-01-01', toDate: '2026-12-31' },
      ],
    });
  }
  if (method === 'GET' && path.endsWith('/draft-entries')) {
    return Response.json({
      items: [
        { entryNumber: 11, journalNumber: 1, voucherNumber: 501, amount: -1250 },
        { entryNumber: 12, journalNumber: 1, voucherNumber: 501, amount: 1250 },
        { entryNumber: 13, journalNumber: 1, voucherNumber: 502, amount: 99 },
        { entryNumber: 21, journalNumber: 2, voucherNumber: 501, amount: 5 },
      ],
    });
  }
  if (method === 'GET' && path === '/suppliers/2001') return Response.json(existingSupplier);
  if (method === 'GET' && path === '/invoices/drafts/404') return new Response('', { status: 404 });
  if (method === 'GET' && path.startsWith('/invoices/drafts/')) return Response.json({ draftInvoiceNumber: 7 });
  if (method === 'POST' && path === '/journals/1/vouchers') return Response.json([{ voucherNumber: 777 }]);
  if (method === 'POST' && path === '/invoices/booked') return Response.json({ bookedInvoiceNumber: 70002 });
  return Response.json({ collection: [] });
}

describe('host policy', () => {
  it('keeps booking off by default: booking tools are not listed and are refused before any request', async () => {
    const { gateway, requests } = fakeEconomic({ enableWrites: true });
    const listed = gateway.tools.map(tool => tool.name);
    for (const name of BOOKING_TOOLS) expect(listed).not.toContain(name);
    expect(listed).toContain('register_payment');

    const result = await gateway.callTool('book_invoice', { draftInvoiceNumber: 7 }, context);
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('booking disabled');
    expect(requests).toEqual([]);
  });

  it('refuses booking in contract mode too unless the policy allows it', async () => {
    const off = createEconomicGateway({ contractMode: true, enableWrites: true });
    expect((await off.callTool('book_invoice', { draftInvoiceNumber: 7 })).isError).toBe(true);
    const on = createEconomicGateway({ contractMode: true, policy: { enableWrites: true, allowBooking: true } });
    const result = await on.callTool('book_invoice', { draftInvoiceNumber: 7 });
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toMatchObject({ mode: 'contract', action: 'booked', draftInvoiceNumber: 7 });
  });

  it('lists the booking tools when booking is allowed', () => {
    const { gateway } = fakeEconomic({ enableWrites: true, allowBooking: true });
    expect(gateway.tools.map(tool => tool.name)).toEqual(expect.arrayContaining(BOOKING_TOOLS));
    expect(gateway.policy).toMatchObject({ enableWrites: true, allowBooking: true, disabledTools: [] });
  });

  it('turns off the tools in disabledTools: not listed, refused before any request (the chart of accounts)', async () => {
    const { gateway, requests } = fakeEconomic({ enableWrites: true, disabledTools: ['upsert_account', 'upsert_supplier'] });
    expect(gateway.tools.map(tool => tool.name)).not.toContain('upsert_account');
    const result = await gateway.callTool('upsert_account', { accountNumber: 2000, name: 'Ny konto', accountType: 'status' }, context);
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toBe('upsert_account is turned off by the host policy.');
    expect(requests).toEqual([]);

    const contract = createEconomicGateway({ contractMode: true, enableWrites: true, policy: { disabledTools: ['upsert_account'] } });
    expect((await contract.callTool('upsert_account', { accountNumber: 2000 })).isError).toBe(true);
  });

  it('offers only the tools in allowedTools', async () => {
    const { gateway, requests } = fakeEconomic({ enableWrites: true, allowedTools: ['check_connection', 'register_payment'] });
    expect(gateway.tools.map(tool => tool.name)).toEqual(['check_connection', 'register_payment']);
    const result = await gateway.callTool('customer_overview', {}, context);
    expect(result.isError).toBe(true);
    expect(requests).toEqual([]);
  });

  it('refuses unclear policies at creation, without echoing the values', () => {
    const create = (policy: unknown, extra: object = {}) => () =>
      createEconomicGateway({ contractMode: true, policy: policy as EconomicHostPolicy, ...extra });
    expect(create({ allowBooking: true })).toThrow('allowBooking requires enableWrites');
    expect(create({ disabledTools: ['secret-looking-name'] })).toThrow('names an unknown tool');
    expect(create({ disabledTools: ['secret-looking-name'] })).not.toThrow('secret-looking-name');
    expect(create({ allowedTools: [] })).toThrow('allowedTools is empty');
    expect(create({ enableWrites: 'yes' })).toThrow('must be a boolean');
    expect(create({ enableWrites: false }, { enableWrites: true })).toThrow('disagree');
    expect(create({ enableWrites: true }, { enableWrites: true })).not.toThrow();
  });

  it('keeps the enableWrites option working on its own', async () => {
    const { gateway, writes } = fakeEconomic(undefined);
    const off = await gateway.callTool('register_payment', payment(), context);
    expect(off.content[0]?.text).toBe('Write blocked by policy: writes disabled');
    expect(writes()).toEqual([]);
  });
});

function payment(extra: GatewayJsonObject = {}): GatewayJsonObject {
  return {
    journalNumber: 1,
    kind: 'customerPayment',
    date: '2026-03-02',
    amount: -1250,
    customerNumber: 1001,
    customerInvoiceNumber: 70001,
    contraAccountNumber: 5820,
    text: 'Indbetaling faktura 70001',
    ...extra,
  };
}

describe('payments and journal entries', () => {
  it('registers a customer payment as a draft journal line in the accounting year of its date', async () => {
    const { gateway, requests, writes } = fakeEconomic({ enableWrites: true });
    const result = await gateway.callTool('register_payment', payment(), context);
    expect(result.isError, result.content[0]?.text).toBeUndefined();
    expect(result.content[0]?.text.split('\n\n')[0]).toBe('Added 1 draft line to journal 1, voucher 777. Not booked.');
    expect(result.content[0]?.text).toBe(`Added 1 draft line to journal 1, voucher 777. Not booked.\n\n${JSON.stringify(result.structuredContent)}`);
    expect(requests.map(request => `${request.method} ${request.path}`)).toEqual([
      'GET /accounting-years',
      'POST /journals/1/vouchers',
    ]);
    expect(writes()[0]?.body).toEqual({
      accountingYear: { year: '2026' },
      journal: { journalNumber: 1 },
      entries: {
        customerPayments: [
          {
            date: '2026-03-02',
            amount: -1250,
            text: 'Indbetaling faktura 70001',
            contraAccount: { accountNumber: 5820 },
            customer: { customerNumber: 1001 },
            customerInvoice: 70001,
          },
        ],
      },
    });
  });

  it('registers a supplier payment against the supplier invoice number', async () => {
    const { gateway, writes } = fakeEconomic({ enableWrites: true });
    const result = await gateway.callTool('register_payment', {
      journalNumber: 1,
      kind: 'supplierPayment',
      date: '2026-03-02',
      amount: 250.5,
      supplierNumber: 2001,
      supplierInvoiceNumber: 'F-77',
      accountingYear: '2026',
      currency: 'DKK',
    }, context);
    expect(result.isError, result.content[0]?.text).toBeUndefined();
    expect(writes()[0]?.body).toMatchObject({
      accountingYear: { year: '2026' },
      entries: {
        supplierPayments: [
          { date: '2026-03-02', amount: 250.5, currency: { code: 'DKK' }, supplier: { supplierNumber: 2001 }, supplierInvoiceNumber: 'F-77' },
        ],
      },
    });
  });

  it('refuses unclear payments before anything is sent', async () => {
    const { gateway, requests } = fakeEconomic({ enableWrites: true });
    const cases: GatewayJsonObject[] = [
      payment({ customerNumber: undefined as unknown as number }),
      payment({ amount: 10.005 }),
      payment({ amount: 0 }),
      payment({ date: '2026-02-30' }),
      payment({ supplierNumber: 2001 }),
      payment({ kind: 'refund' }),
      payment({ accountingYear: 'last year' }),
    ];
    for (const input of cases) {
      const clean = Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined)) as GatewayJsonObject;
      const result = await gateway.callTool('register_payment', clean, context);
      expect(result.isError, JSON.stringify(clean)).toBe(true);
    }
    expect(requests).toEqual([]);
  });

  it('refuses lines that span two accounting years', async () => {
    const { gateway, writes } = fakeEconomic({ enableWrites: true });
    const result = await gateway.callTool('create_journal_entries', {
      journalNumber: 1,
      entries: [
        { type: 'financeVoucher', date: '2025-12-31', amount: 1, accountNumber: 1010 },
        { type: 'financeVoucher', date: '2026-01-01', amount: -1, accountNumber: 1010 },
      ],
    }, context);
    expect(result.content[0]?.text).toContain('more than one accounting year');
    expect(writes()).toEqual([]);
  });

  it('creates ledger lines and supplier invoices in one voucher, and refuses payment details', async () => {
    const { gateway, writes } = fakeEconomic({ enableWrites: true });
    const ok = await gateway.callTool('create_journal_entries', {
      journalNumber: 1,
      voucherNumber: 900,
      entries: [
        { type: 'financeVoucher', date: '2026-03-02', amount: 100, accountNumber: 1010, contraAccountNumber: 5820, vatCode: 'I25' },
        { type: 'supplierInvoice', date: '2026-03-02', amount: -250.5, supplierNumber: 2001, supplierInvoiceNumber: 'F-77', dueDate: '2026-04-01' },
      ],
    }, context);
    expect(ok.isError, ok.content[0]?.text).toBeUndefined();
    expect(writes()[0]?.body).toMatchObject({
      voucherNumber: 900,
      entries: {
        financeVouchers: [{ account: { accountNumber: 1010 }, contraAccount: { accountNumber: 5820 }, vatAccount: { vatCode: 'I25' } }],
        supplierInvoices: [{ supplier: { supplierNumber: 2001 }, supplierInvoiceNumber: 'F-77', dueDate: '2026-04-01' }],
      },
    });

    const refused = await gateway.callTool('create_journal_entries', {
      journalNumber: 1,
      entries: [{
        type: 'supplierInvoice',
        date: '2026-03-02',
        amount: -10,
        supplierNumber: 2001,
        paymentDetails: { fiSupplierNo: '12345678', ocrLine: '000000' },
      } as unknown as GatewayJsonObject],
    }, context);
    expect(refused.isError).toBe(true);
    expect(refused.content[0]?.text).toContain('Bank details');
    expect(writes()).toHaveLength(1);
  });
});

describe('booking', () => {
  const booking: EconomicHostPolicy = { enableWrites: true, allowBooking: true };

  it('books the draft lines of a voucher, and only that journal’s', async () => {
    const { gateway, writes } = fakeEconomic(booking);
    const result = await gateway.callTool('book_journal_entries', { journalNumber: 1, voucherNumbers: [501], requireVoucher: false }, context);
    expect(result.isError, result.content[0]?.text).toBeUndefined();
    expect(result.content[0]?.text.split('\n\n')[0]).toBe('Booked 2 entries in journal 1.');
    expect(result.content[0]?.text).toBe(`Booked 2 entries in journal 1.\n\n${JSON.stringify(result.structuredContent)}`);
    expect(writes()).toEqual([
      { method: 'POST', path: '/journalsapi/v16.0.1/journals/1/bookdraftentries', body: { entryNumbers: [11, 12] } },
    ]);
  });

  it('checks the voucher document unless told not to, and books nothing when an entry is missing', async () => {
    const { gateway, requests, writes } = fakeEconomic(booking);
    const withDocument = await gateway.callTool('book_journal_entries', { journalNumber: 1, entryNumbers: [13] }, context);
    expect(withDocument.isError, withDocument.content[0]?.text).toBeUndefined();
    expect(requests.some(request => request.path.endsWith('/AttachedDocuments/502'))).toBe(true);

    const missing = await gateway.callTool('book_journal_entries', { journalNumber: 1, entryNumbers: [21] }, context);
    expect(missing.isError).toBe(true);
    expect(writes()).toHaveLength(1);
  });

  it('refuses both or neither of entryNumbers and voucherNumbers', async () => {
    const { gateway, requests } = fakeEconomic(booking);
    expect((await gateway.callTool('book_journal_entries', { journalNumber: 1 }, context)).isError).toBe(true);
    expect((await gateway.callTool('book_journal_entries', { journalNumber: 1, entryNumbers: [11], voucherNumbers: [501] }, context)).isError).toBe(true);
    expect(requests).toEqual([]);
  });

  it('books a draft invoice without sending it electronically', async () => {
    const { gateway, requests, writes } = fakeEconomic(booking);
    const result = await gateway.callTool('book_invoice', { draftInvoiceNumber: 7 }, context);
    expect(result.isError, result.content[0]?.text).toBeUndefined();
    expect(result.content[0]?.text.split('\n\n')[0]).toBe('Booked draft invoice 7 as invoice 70002. Not sent electronically.');
    expect(result.content[0]?.text).toBe(`Booked draft invoice 7 as invoice 70002. Not sent electronically.\n\n${JSON.stringify(result.structuredContent)}`);
    expect(requests[0]).toMatchObject({ method: 'GET', path: '/invoices/drafts/7' });
    expect(writes()).toEqual([
      { method: 'POST', path: '/invoices/booked', body: { draftInvoice: { draftInvoiceNumber: 7 }, sendBy: 'none' } },
    ]);

    const gone = await gateway.callTool('book_invoice', { draftInvoiceNumber: 404 }, context);
    expect(gone.content[0]?.text).toContain('does not exist');
    expect(writes()).toHaveLength(1);
  });

  it('matches open items', async () => {
    const { gateway, writes } = fakeEconomic(booking);
    const result = await gateway.callTool('match_open_items', { entryIds: [800001, 800002] }, context);
    expect(result.isError, result.content[0]?.text).toBeUndefined();
    expect(writes()).toEqual([
      { method: 'POST', path: '/bookedEntriesapi/v7.0.0/booked-entries/match', body: { entryIds: [800001, 800002] } },
    ]);
    const one = await gateway.callTool('match_open_items', { entryIds: [800001] }, context);
    expect(one.isError).toBe(true);
  });

  it('keeps booking a draft invoice denied by the base policy for every other capability', () => {
    const policy = { ...basePolicy(), writesEnabled: true, bookingEnabled: true };
    expect(checkPolicy({ capability: 'create_draft_invoice', serviceId: 'rest', method: 'POST', path: '/invoices/booked' }, policy).allowed).toBe(false);
    expect(checkPolicy({ capability: 'book_invoice', serviceId: 'rest', method: 'POST', path: '/invoices/booked' }, policy).allowed).toBe(true);
    expect(checkPolicy({ capability: 'book_invoice', serviceId: 'rest', method: 'POST', path: '/invoices/drafts' }, policy).allowed).toBe(false);
    expect(checkPolicy({ capability: 'book_invoice', serviceId: 'rest', method: 'POST', path: '/invoices/booked' }, { ...policy, bookingEnabled: false }).allowed).toBe(false);
  });
});

describe('bank details are never changed', () => {
  const writes: EconomicHostPolicy = { enableWrites: true };

  it('refuses bank fields on a new or existing supplier before any request, in every form', async () => {
    const { gateway, requests } = fakeEconomic(writes);
    const fields: GatewayJsonObject[] = [
      { bankAccount: '9999-0009999999' },
      { remittanceAdvice: { creditorId: '9999-0009999999' } },
      { iban: 'DK0099990009999999' },
      { swift: 'DEMODKKK' },
      { bic: 'DEMODKKK' },
      { registrationNumber: '9999' },
      { nested: { BankAccountNumber: '1' } },
    ];
    for (const bankField of fields) {
      const bases: GatewayJsonObject[] = [
        { name: 'Ny leverandør', currency: 'DKK', supplierGroupNumber: 1, paymentTermsNumber: 1, vatZoneNumber: 1 },
        { supplierNumber: 2001 },
      ];
      for (const base of bases) {
        const result = await gateway.callTool('upsert_supplier', { ...base, ...bankField }, context);
        expect(result.isError, JSON.stringify(bankField)).toBe(true);
        expect(result.content[0]?.text).toContain('Bank details');
      }
    }
    expect(requests).toEqual([]);

    const contract = createEconomicGateway({ contractMode: true, enableWrites: true });
    expect((await contract.callTool('upsert_supplier', { supplierNumber: 2001, bankAccount: '1' })).isError).toBe(true);
  });

  it('updates a supplier and keeps its bank details as they are', async () => {
    const { gateway, writes: sent } = fakeEconomic(writes);
    const result = await gateway.callTool('upsert_supplier', { supplierNumber: 2001, email: 'ny@example.test', phone: '12345678' }, context);
    expect(result.isError, result.content[0]?.text).toBeUndefined();
    expect(sent()[0]).toMatchObject({
      method: 'PUT',
      path: '/suppliers/2001',
      body: { email: 'ny@example.test', phone: '12345678', bankAccount: existingSupplier.bankAccount, remittanceAdvice: existingSupplier.remittanceAdvice },
    });
  });

  it('denies writes to the company record in the base policy', () => {
    const policy = { ...basePolicy(), writesEnabled: true };
    expect(checkPolicy({ capability: 'economic_call_endpoint', serviceId: 'rest', method: 'PUT', path: '/self' }, policy).allowed).toBe(false);
  });

  it('finds e-conomic’s bank field names, and not ledger accounts', () => {
    expect(bankFieldPaths({ bankAccount: 'x', costAccount: { accountNumber: 1 }, remittanceAdvice: { creditorId: 'y' } })).toEqual([
      'bankAccount',
      'remittanceAdvice',
    ]);
    expect(bankFieldPaths({ bankInformation: { bankAccountNumber: '1' } })).toEqual(['bankInformation']);
    expect(bankFieldPaths({ entries: { supplierInvoices: [{ paymentDetails: { giroAccount: '1' } }] } })).toEqual([
      'entries.supplierInvoices[0].paymentDetails',
    ]);
    expect(bankFieldPaths({ costAccount: { accountNumber: 1 }, contraAccount: { accountNumber: 5820 }, paymentTerms: { paymentTermsNumber: 1 } })).toEqual([]);
    expect(changedBankFields(existingSupplier, { ...existingSupplier, name: 'x' })).toEqual([]);
    expect(changedBankFields(existingSupplier, { ...existingSupplier, bankAccount: '1' })).toEqual(['bankAccount']);
    expect(changedBankFields(existingSupplier, { name: 'x' })).toEqual(['bankAccount', 'remittanceAdvice']);
  });

  it('guards the standalone server’s raw and prepared writes the same way', async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const request = new Request(input, init);
      return defaultResponse(request.method, new URL(request.url).pathname);
    });
    const client = new EconomicClient({
      appSecretToken: 'app-secret-for-tests',
      agreementGrantToken: 'grant-token-for-tests',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      credentialEnv: {},
    });
    await expect(assertNoBankChange(client, {
      serviceId: 'rest', method: 'POST', pathTemplate: '/suppliers', body: { name: 'S', bankAccount: '1' },
    })).rejects.toThrow('Bank details');
    await expect(assertNoBankChange(client, {
      serviceId: 'rest', method: 'PUT', pathTemplate: '/suppliers/{number}', pathParams: { number: 2001 },
      body: { ...existingSupplier, bankAccount: '9999-0009999999' },
    })).rejects.toThrow('bankAccount');
    await expect(assertNoBankChange(client, {
      serviceId: 'rest', method: 'PUT', pathTemplate: '/suppliers/{number}', pathParams: { number: 2001 },
      body: { ...existingSupplier, name: 'Nyt navn' },
    })).resolves.toBeUndefined();
    await expect(assertNoBankChange(client, {
      serviceId: 'journals', method: 'POST', pathTemplate: '/draft-entries', body: { paymentDetails: { ocrLine: '1' } },
    })).rejects.toThrow('Bank details');
  });
});

describe('change targets for the host’s log', () => {
  it('describes every write tool, and marks the booking tools', () => {
    for (const entry of economicToolCatalog) {
      if (entry.riskLevel === 'read') {
        expect(entry.change, entry.name).toBeUndefined();
        expect(entry.booking).toBe(false);
        continue;
      }
      expect(entry.change, entry.name).toBeDefined();
      const properties = Object.keys((entry.inputSchema.properties ?? {}) as object);
      for (const field of entry.change!.logFields) expect(properties, `${entry.name}.${field.name}`).toContain(field.name);
      expect(entry.change!.logFields.map(field => field.name)).not.toContain('supplierInvoiceNumber');
      expect(entry.booking, entry.name).toBe(BOOKING_TOOLS.includes(entry.name));
    }
  });

  it('resolves the values that identify a change, never names or free text', () => {
    const resolved = resolveEconomicChange('register_payment', payment());
    expect(resolved).toEqual({
      ok: true,
      change: {
        tool: 'register_payment',
        action: 'register',
        record: 'payment',
        booking: false,
        values: {
          journalNumber: 1,
          kind: 'customerPayment',
          customerNumber: 1001,
          customerInvoiceNumber: 70001,
          amount: -1250,
          date: '2026-03-02',
        },
      },
    });
    expect(resolveEconomicChange('book_journal_entries', { journalNumber: 1, voucherNumbers: [501, 502] })).toMatchObject({
      ok: true,
      change: { action: 'book', booking: true, values: { journalNumber: 1, voucherNumbers: [501, 502] } },
    });
    expect(resolveEconomicChange('create_journal_entries', { journalNumber: 1, entries: [{}, {}] })).toMatchObject({
      ok: true,
      change: { values: { journalNumber: 1, lineCount: 2 } },
    });
    expect(resolveEconomicChange('upsert_supplier', { supplierNumber: 2001, name: 'Demo Grossist A/S' })).toMatchObject({
      ok: true,
      change: { values: { supplierNumber: 2001 } },
    });
    expect(resolveEconomicChange('customer_overview', {})).toMatchObject({ ok: false });
    expect(resolveEconomicChange('register_payment', { surprise: 1 })).toMatchObject({ ok: false });
  });
});

describe('review regressions', () => {
  it('canonicalises a path without the leading "/" before any policy check', () => {
    const { call, path } = canonicalEndpointCall({ serviceId: 'rest', method: 'POST', pathTemplate: 'invoices/booked', body: {} });
    expect(call.pathTemplate).toBe('/invoices/booked');
    expect(path).toBe('/invoices/booked');
    const policy = { ...basePolicy(), writesEnabled: true, bookingEnabled: false };
    for (const raw of ['invoices/booked', '/invoices/booked', ' invoices/booked']) {
      expect(checkPolicy({ capability: 'economic_call_endpoint', serviceId: 'rest', method: 'POST', path: raw }, policy).allowed, raw).toBe(false);
      expect(checkPolicy({ capability: 'book_invoice', serviceId: 'rest', method: 'POST', path: raw }, policy).allowed, raw).toBe(false);
    }
    expect(checkPolicy({ capability: 'economic_call_endpoint', serviceId: 'rest', method: 'PUT', path: 'self' }, policy).allowed).toBe(false);
    const journal = canonicalEndpointCall({
      serviceId: 'journals', method: 'POST', pathTemplate: 'journals/{journalNumber}/bookdraftentries', pathParams: { journalNumber: 1 },
    });
    expect(journal.path).toBe('/journals/1/bookdraftentries');
    expect(checkPolicy({ capability: 'economic_call_endpoint', serviceId: 'journals', method: 'POST', path: journal.path }, policy).allowed).toBe(false);
  });

  it('compares supplier bank details on a PUT written without the leading "/"', async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const request = new Request(input, init);
      return defaultResponse(request.method, new URL(request.url).pathname);
    });
    const client = new EconomicClient({
      appSecretToken: 'app-secret-for-tests',
      agreementGrantToken: 'grant-token-for-tests',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      credentialEnv: {},
    });
    // A full replace without the bank fields would wipe them.
    const withoutBank: Record<string, unknown> = { ...existingSupplier };
    delete withoutBank.bankAccount;
    delete withoutBank.remittanceAdvice;
    await expect(assertNoBankChange(client, {
      serviceId: 'rest', method: 'PUT', pathTemplate: 'suppliers/{number}', pathParams: { number: 2001 }, body: withoutBank,
    })).rejects.toThrow('bankAccount');
    await expect(assertNoBankChange(client, {
      serviceId: 'rest', method: 'PUT', pathTemplate: 'suppliers/{number}', pathParams: { number: 2001 },
      body: { ...existingSupplier, name: 'Nyt navn' },
    })).resolves.toBeUndefined();
  });

  it('never puts a name or free text in the log values, whatever the input type', () => {
    for (const text of ['Anna Hansen', 'Private confidential note', 'Anna', '12 34']) {
      const resolvedPayment = resolveEconomicChange('register_payment', {
        journalNumber: text, kind: text, customerNumber: text, customerInvoiceNumber: text, supplierNumber: text,
        supplierInvoiceNumber: text, amount: text, currency: text, date: text, accountingYear: text,
      });
      expect(resolvedPayment.ok).toBe(true);
      if (resolvedPayment.ok) expect(resolvedPayment.change.values, text).toEqual({});
      const others: Array<[string, GatewayJsonObject]> = [
        ['upsert_product', { productNumber: text }],
        ['create_journal_entries', { journalNumber: 1, accountingYear: text, voucherNumber: text, entries: [] }],
        ['book_journal_entries', { journalNumber: 1, entryNumbers: [1, text] }],
        ['create_time_entry', { projectNumber: 1, date: text, hours: text }],
      ];
      for (const [tool, input] of others) {
        const resolved = resolveEconomicChange(tool, input);
        expect(resolved.ok, tool).toBe(true);
        if (resolved.ok) expect(JSON.stringify(resolved.change.values), `${tool} ${text}`).not.toContain(text);
      }
    }
    const ok = resolveEconomicChange('register_payment', {
      journalNumber: 1, kind: 'supplierPayment', supplierNumber: 2001, supplierInvoiceNumber: 'F-77', amount: 250.5, currency: 'DKK', date: '2026-03-02',
    });
    expect(ok).toEqual({
      ok: true,
      change: {
        tool: 'register_payment',
        action: 'register',
        record: 'payment',
        booking: false,
        values: { journalNumber: 1, kind: 'supplierPayment', supplierNumber: 2001, amount: 250.5, currency: 'DKK', date: '2026-03-02' },
      },
    });
    expect(resolveEconomicChange('register_payment', { amount: 10.005, date: '2026-02-30' })).toMatchObject({ ok: true, change: { values: {} } });
    expect(resolveEconomicChange('upsert_product', { productNumber: '4711' })).toMatchObject({ change: { values: { productNumber: '4711' } } });
  });

  it('exports date patterns that accept an ISO date and reject other text', () => {
    const patterns: string[] = [];
    const collect = (value: unknown, key = ''): void => {
      if (Array.isArray(value)) value.forEach(item => collect(item));
      else if (value && typeof value === 'object') {
        for (const [nestedKey, nested] of Object.entries(value)) collect(nested, nestedKey);
      } else if (key === 'pattern' && typeof value === 'string') patterns.push(value);
    };
    for (const name of ['create_journal_entries', 'register_payment']) {
      collect(economicToolCatalog.find(entry => entry.name === name)!.inputSchema);
    }
    const datePatterns = patterns.filter(pattern => pattern.includes('{4}'));
    expect(datePatterns.length).toBeGreaterThanOrEqual(3);
    for (const pattern of datePatterns) {
      expect(pattern).toBe('^\\d{4}-\\d{2}-\\d{2}$');
      const regex = new RegExp(pattern);
      expect(regex.test('2026-03-02'), pattern).toBe(true);
      expect(regex.test('dddd-dd-dd'), pattern).toBe(false);
      expect(regex.test('2. marts'), pattern).toBe(false);
    }
  });

  it('refuses writes in contract mode when writes are off', async () => {
    const off = createEconomicGateway({ contractMode: true });
    const writesOff: Array<[string, GatewayJsonObject]> = [
      ['create_draft_invoice', { customerNumber: 1001, lines: [{ productNumber: 'P1', quantity: 1 }] }],
      ['register_payment', payment()],
      ['upsert_customer', { customerNumber: 1001, name: 'X' }],
    ];
    for (const [tool, input] of writesOff) {
      const result = await off.callTool(tool, input);
      expect(result.isError, tool).toBe(true);
      expect(result.content[0]?.text).toBe('Write blocked by policy: writes disabled');
    }
    expect((await off.callTool('customer_overview', {})).isError).toBeUndefined();
    const on = createEconomicGateway({ contractMode: true, policy: { enableWrites: true } });
    expect((await on.callTool('register_payment', payment())).isError).toBeUndefined();
  });
});

describe('review round 2', () => {
  it('refuses to book by voucher when the draft list does not end within the page cap, and books nothing', async () => {
    let pages = 0;
    const { gateway, writes } = fakeEconomic({ enableWrites: true, allowBooking: true }, (request) => {
      const url = new URL(request.url);
      if (request.method !== 'GET' || !url.pathname.endsWith('/draft-entries')) return undefined;
      pages += 1;
      // Voucher 501 has a line on the first page; its other line would come after the cap.
      const items = pages === 1 ? [{ entryNumber: 1, journalNumber: 1, voucherNumber: 501, amount: 100 }] : [{ entryNumber: 100000 + pages, journalNumber: 1, voucherNumber: 900, amount: 1 }];
      return Response.json({ items, cursor: `page-${pages + 1}` });
    });
    const result = await gateway.callTool('book_journal_entries', { journalNumber: 1, voucherNumbers: [501], requireVoucher: false }, context);
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('did not fit in');
    expect(pages).toBe(MAX_DRAFT_PAGES);
    expect(writes()).toEqual([]);

    const byEntry = await gateway.callTool('book_journal_entries', { journalNumber: 1, entryNumbers: [1], requireVoucher: false }, context);
    expect(byEntry.isError).toBe(true);
    expect(writes()).toEqual([]);
  });

  it('reads every page before booking a voucher', async () => {
    let pages = 0;
    const { gateway, writes } = fakeEconomic({ enableWrites: true, allowBooking: true }, (request) => {
      const url = new URL(request.url);
      if (request.method !== 'GET' || !url.pathname.endsWith('/draft-entries')) return undefined;
      pages += 1;
      // The page number comes from the cursor, so every read of the list sees all 15 pages.
      const page = Number(url.searchParams.get('cursor')?.replace('page-', '') ?? '1');
      const last = page === 15;
      const items = page === 1 || last
        ? [{ entryNumber: last ? 10001 : 1, journalNumber: 1, voucherNumber: 501, amount: last ? -100 : 100 }]
        : [{ entryNumber: 1000 + page, journalNumber: 1, voucherNumber: 900, amount: 1 }];
      return Response.json({ items, cursor: last ? null : `page-${page + 1}` });
    });
    const result = await gateway.callTool('book_journal_entries', { journalNumber: 1, voucherNumbers: [501], requireVoucher: false }, context);
    expect(result.isError, result.content[0]?.text).toBeUndefined();
    expect(result.content[0]?.text.split('\n\n')[0]).toBe('Booked 2 entries in journal 1.');
    expect(result.content[0]?.text).toBe(`Booked 2 entries in journal 1.\n\n${JSON.stringify(result.structuredContent)}`);
    expect(writes()[0]?.body).toEqual({ entryNumbers: [1, 10001] });
    expect(pages).toBe(30); // read in full when resolving the voucher, and again when validating
  });

  it('refuses the standalone server’s booking from a partial draft list too', async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input instanceof Request ? input.url : input));
      return Response.json({ items: [{ entryNumber: 1, journalNumber: 1, voucherNumber: 501, amount: 1 }], cursor: `c${url.searchParams.get('cursor') ?? ''}x` });
    });
    const client = new EconomicClient({
      appSecretToken: 'app-secret-for-tests',
      agreementGrantToken: 'grant-token-for-tests',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      credentialEnv: {},
    });
    await expect(validateBooking(client, { journalNumber: 1, entryNumbers: [1], requireVoucher: false }, {})).rejects.toThrow('did not fit in');
  });

  it('logs only real ISO 4217 codes written in capitals, never a three-letter name', () => {
    for (const currency of ['Bob', 'bob', 'Ann', 'ANN', 'Eva', 'XYZ', 'dkk', 'DK', 'DKKK']) {
      const resolved = resolveEconomicChange('register_payment', { journalNumber: 1, amount: 10, currency });
      expect(resolved.ok).toBe(true);
      if (resolved.ok) expect(resolved.change.values, currency).not.toHaveProperty('currency');
    }
    for (const currency of ['DKK', 'EUR', 'SEK', 'NOK', 'USD']) {
      expect(resolveEconomicChange('create_draft_invoice', { customerNumber: 1, currency })).toMatchObject({ change: { values: { currency } } });
    }
  });

  it('refuses a lower-case or unknown currency in the tools themselves', async () => {
    const { gateway, requests } = fakeEconomic({ enableWrites: true });
    for (const currency of ['dkk', 'Bob', 'ANN']) {
      const result = await gateway.callTool('register_payment', payment({ currency }), context);
      expect(result.isError, currency).toBe(true);
    }
    expect(requests).toEqual([]);
  });

  it('logs enum and accounting-year fields only in their exact form', () => {
    for (const kind of ['Anna Hansen', 'customerpayment', 'customerPayment ']) {
      const resolved = resolveEconomicChange('register_payment', { kind });
      if (resolved.ok) expect(resolved.change.values, kind).not.toHaveProperty('kind');
    }
    for (const accountingYear of ['Anna', '2026a', '2025/26', '20261', ' 2026']) {
      const resolved = resolveEconomicChange('create_journal_entries', { journalNumber: 1, accountingYear });
      if (resolved.ok) expect(resolved.change.values, accountingYear).not.toHaveProperty('accountingYear');
    }
    expect(resolveEconomicChange('create_journal_entries', { journalNumber: 1, accountingYear: '2025/2026' })).toMatchObject({
      change: { values: { accountingYear: '2025/2026' } },
    });
  });
});
