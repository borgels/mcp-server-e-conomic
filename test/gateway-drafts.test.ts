// Changing draft invoices and credit notes as drafts in ./gateway (#70).
import { describe, expect, it } from 'vitest';
import { createEconomicGateway, resolveEconomicChange, type GatewayJsonObject } from '../src/gateway.js';

const context = { credentials: { agreementGrantToken: 'grant-token-for-tests' } };

function fakeEconomic(answer: (request: Request) => Response | undefined = () => undefined, enableWrites = true) {
  const requests: Array<{ method: string; path: string; body?: unknown }> = [];
  const gateway = createEconomicGateway({
    appSecretToken: 'app-secret-for-tests',
    policy: { enableWrites },
    fetchImpl: (async (input: string | URL | Request, init?: RequestInit) => {
      const request = new Request(input, init);
      const text = request.method === 'GET' ? '' : await request.clone().text();
      requests.push({ method: request.method, path: new URL(request.url).pathname, ...(text ? { body: JSON.parse(text) } : {}) });
      return answer(request) ?? Response.json({ draftInvoiceNumber: 31 });
    }) as typeof fetch,
  });
  return { gateway, requests };
}

const draft = {
  draftInvoiceNumber: 7,
  soap: { currentInvoiceHandle: { id: 7 } },
  templates: { self: 'https://restapi.e-conomic.com/invoices/drafts/7/templates' },
  attachment: 'https://restapi.e-conomic.com/invoices/drafts/7/attachment',
  pdf: { download: 'https://restapi.e-conomic.com/invoices/drafts/7/pdf' },
  self: 'https://restapi.e-conomic.com/invoices/drafts/7',
  lastUpdated: '2026-03-01T10:00:00Z',
  date: '2026-03-01',
  currency: 'DKK',
  netAmount: 100,
  grossAmount: 125,
  vatAmount: 25,
  paymentTerms: { paymentTermsNumber: 1, name: 'Netto 8 dage', daysOfCredit: 8, paymentTermsType: 'net', self: 'https://restapi.e-conomic.com/payment-terms/1' },
  customer: { customerNumber: 1001, self: 'https://restapi.e-conomic.com/customers/1001' },
  recipient: { name: 'Kunde A/S', vatZone: { vatZoneNumber: 1, self: 'https://restapi.e-conomic.com/vat-zones/1' } },
  notes: { heading: 'Faktura', textLine1: 'Linje et', textLine2: 'Linje to' },
  layout: { layoutNumber: 19 },
  references: { salesPerson: { employeeNumber: 1, self: 'https://restapi.e-conomic.com/employees/1' } },
  lines: [{ lineNumber: 1, product: { productNumber: 'P1', self: 'https://restapi.e-conomic.com/products/P1' }, quantity: 1, unitNetPrice: 100, totalNetAmount: 100, marginInBaseCurrency: 40 }],
};

const booked = {
  bookedInvoiceNumber: 70001,
  date: '2026-02-01',
  currency: 'DKK',
  paymentTerms: { paymentTermsNumber: 1, name: 'Netto 8 dage' },
  customer: { customerNumber: 1001, self: 'https://restapi.e-conomic.com/customers/1001' },
  recipient: { name: 'Kunde A/S', address: 'Eksempelvej 1', zip: '1000', city: 'Byen', vatZone: { vatZoneNumber: 1, name: 'Domestic' }, attention: { customerContactNumber: 2 } },
  layout: { layoutNumber: 19 },
  lines: [
    { lineNumber: 1, product: { productNumber: 'P1' }, description: 'Timer', quantity: 4, unitNetPrice: 875, discountPercentage: 10, unit: { unitNumber: 1, name: 'timer' } },
    { lineNumber: 2, description: 'Tak for handlen' },
    { lineNumber: 3, product: { productNumber: 'P2' }, quantity: 1, unitNetPrice: 2400 },
  ],
};

describe('update_draft_invoice', () => {
  it('merges the change into the draft and sends it back without links', async () => {
    const { gateway, requests } = fakeEconomic(request => (request.method === 'GET' ? Response.json(draft) : undefined));
    const result = await gateway.callTool('update_draft_invoice', {
      draftInvoiceNumber: 7,
      dueDate: '2026-03-15',
      reference: 'PO 12',
      lines: [{ productNumber: 'P1', quantity: 3 }, { productNumber: 'P2', quantity: 1, unitNetPrice: 50 }],
    }, context);
    expect(result.isError, result.content[0]?.text).toBeUndefined();
    expect(result.content[0]?.text.split('\n\n')[0]).toBe('Changed draft invoice 7. Not booked or sent.');
    const put = requests.find(request => request.method === 'PUT')!;
    expect(put.path).toBe('/invoices/drafts/7');
    expect(put.body).toEqual({
      date: '2026-03-01',
      dueDate: '2026-03-15',
      currency: 'DKK',
      paymentTerms: { paymentTermsNumber: 1 },
      customer: { customerNumber: 1001 },
      recipient: { name: 'Kunde A/S', vatZone: { vatZoneNumber: 1 } },
      notes: { heading: 'Faktura', textLine1: 'Linje et', textLine2: 'Linje to' },
      layout: { layoutNumber: 19 },
      references: { salesPerson: { employeeNumber: 1 }, other: 'PO 12' },
      lines: [
        { lineNumber: 1, product: { productNumber: 'P1' }, quantity: 3 },
        { lineNumber: 2, product: { productNumber: 'P2' }, quantity: 1, unitNetPrice: 50 },
      ],
    });
  });

  it('keeps the draft’s other notes when only the heading changes, and sends no computed line fields', async () => {
    const { gateway, requests } = fakeEconomic(request => (request.method === 'GET' ? Response.json(draft) : undefined));
    const result = await gateway.callTool('update_draft_invoice', { draftInvoiceNumber: 7, notes: { heading: 'Ny overskrift' } }, context);
    expect(result.isError, result.content[0]?.text).toBeUndefined();
    const put = requests.find(request => request.method === 'PUT')!.body as GatewayJsonObject;
    expect(put.notes).toEqual({ heading: 'Ny overskrift', textLine1: 'Linje et', textLine2: 'Linje to' });
    expect(put.lines).toEqual([{ lineNumber: 1, product: { productNumber: 'P1' }, quantity: 1, unitNetPrice: 100 }]);
    expect(JSON.stringify(put)).not.toMatch(/self|netAmount|grossAmount|vatAmount|margin|daysOfCredit|paymentTermsType|Netto/);
    expect(put.paymentTerms).toEqual({ paymentTermsNumber: 1 });
  });

  it('refuses an empty change, bad fields, and a draft that is gone; nothing is sent', async () => {
    const gone = fakeEconomic(() => new Response('{}', { status: 404 }));
    expect((await gone.gateway.callTool('update_draft_invoice', { draftInvoiceNumber: 7, date: '2026-03-02' }, context)).content[0]?.text)
      .toBe('Draft invoice 7 does not exist (already booked or deleted?).');
    const { gateway, requests } = fakeEconomic();
    for (const input of [
      { draftInvoiceNumber: 7 },
      { draftInvoiceNumber: 7, date: '1. marts' },
      { draftInvoiceNumber: 7, lines: [{ quantity: 1 }] },
      { draftInvoiceNumber: 7, notes: {} },
    ] as GatewayJsonObject[]) {
      expect((await gateway.callTool('update_draft_invoice', input, context)).isError, JSON.stringify(input)).toBe(true);
    }
    expect(requests).toEqual([]);
  });

  it('logs the draft number, dates and the line count', () => {
    expect(resolveEconomicChange('update_draft_invoice', { draftInvoiceNumber: 7, date: '2026-03-02', reference: 'PO 12', lines: [{ productNumber: 'P1', quantity: 1 }] }))
      .toMatchObject({ ok: true, change: { action: 'upsert', record: 'draft-invoice', values: { draftInvoiceNumber: 7, date: '2026-03-02', lineCount: 1 } } });
  });
});

describe('create_credit_note_draft', () => {
  it('builds a draft with the invoice’s lines at negative quantities, referring to the invoice', async () => {
    const { gateway, requests } = fakeEconomic(request => (request.method === 'GET' ? Response.json(booked) : undefined));
    const result = await gateway.callTool('create_credit_note_draft', { bookedInvoiceNumber: 70001, date: '2026-03-02' }, context);
    expect(result.isError, result.content[0]?.text).toBeUndefined();
    expect(result.content[0]?.text.split('\n\n')[0]).toBe('Created a credit note for invoice 70001 as draft invoice 31. Not booked or sent.');
    expect(requests).toEqual([
      { method: 'GET', path: '/invoices/booked/70001' },
      {
        method: 'POST',
        path: '/invoices/drafts',
        body: {
          date: '2026-03-02',
          currency: 'DKK',
          paymentTerms: { paymentTermsNumber: 1 },
          customer: { customerNumber: 1001 },
          recipient: { name: 'Kunde A/S', vatZone: { vatZoneNumber: 1 }, address: 'Eksempelvej 1', zip: '1000', city: 'Byen' },
          layout: { layoutNumber: 19 },
          references: { other: '70001' },
          lines: [
            { lineNumber: 1, product: { productNumber: 'P1' }, quantity: -4, description: 'Timer', unitNetPrice: 875, discountPercentage: 10, unit: { unitNumber: 1 } },
            { lineNumber: 2, product: { productNumber: 'P2' }, quantity: -1, unitNetPrice: 2400 },
          ],
        },
      },
    ]);
  });

  it('sends a due date when the invoice’s payment terms are of the type dueDate', async () => {
    const dueTerms = { ...booked, paymentTerms: { paymentTermsNumber: 4, paymentTermsType: 'dueDate' } };
    const { gateway, requests } = fakeEconomic(request => (request.method === 'GET' ? Response.json(dueTerms) : undefined));
    await gateway.callTool('create_credit_note_draft', { bookedInvoiceNumber: 70001, date: '2026-03-02' }, context);
    expect(requests.at(-1)?.body).toMatchObject({ date: '2026-03-02', dueDate: '2026-03-02', paymentTerms: { paymentTermsNumber: 4 } });
    const given = fakeEconomic(request => (request.method === 'GET' ? Response.json(dueTerms) : undefined));
    await given.gateway.callTool('create_credit_note_draft', { bookedInvoiceNumber: 70001, date: '2026-03-02', dueDate: '2026-03-30' }, context);
    expect(given.requests.at(-1)?.body).toMatchObject({ dueDate: '2026-03-30' });
    expect((await given.gateway.callTool('create_credit_note_draft', { bookedInvoiceNumber: 70001, dueDate: 'soon' }, context)).isError).toBe(true);
  });

  it('credits only the chosen lines, and refuses a line the invoice does not have', async () => {
    const { gateway, requests } = fakeEconomic(request => (request.method === 'GET' ? Response.json(booked) : undefined));
    const part = await gateway.callTool('create_credit_note_draft', { bookedInvoiceNumber: 70001, lineNumbers: [3], reference: 'Retur' }, context);
    expect(part.isError).toBeUndefined();
    expect(requests.at(-1)!.body).toMatchObject({
      references: { other: 'Retur' },
      lines: [{ lineNumber: 1, product: { productNumber: 'P2' }, quantity: -1 }],
    });
    const wrong = await gateway.callTool('create_credit_note_draft', { bookedInvoiceNumber: 70001, lineNumbers: [9] }, context);
    expect(wrong).toMatchObject({ isError: true, content: [{ text: 'Booked invoice 70001 has no line 9.' }] });
  });

  it('is refused when writes are off, before the invoice is read', async () => {
    const { gateway, requests } = fakeEconomic(undefined, false);
    expect((await gateway.callTool('create_credit_note_draft', { bookedInvoiceNumber: 70001 }, context)).isError).toBe(true);
    expect(requests).toEqual([]);
  });

  it('logs the invoice number, the date and the line count', () => {
    expect(resolveEconomicChange('create_credit_note_draft', { bookedInvoiceNumber: 70001, lineNumbers: [1, 3], date: '2026-03-02' }))
      .toMatchObject({ ok: true, change: { action: 'create', record: 'credit-note-draft', values: { bookedInvoiceNumber: 70001, date: '2026-03-02', lineCount: 2 } } });
  });
});
