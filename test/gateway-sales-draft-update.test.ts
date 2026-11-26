// Changing a draft quote or a draft order in ./gateway (#106).
import { describe, expect, it } from 'vitest';
import {
  createEconomicGateway,
  economicToolCatalog,
  fenceRule,
  resolveEconomicChange,
  type GatewayJsonObject,
} from '../src/gateway.js';

const context = { credentials: { agreementGrantToken: 'grant-token-for-tests' } };

type Seen = { method: string; path: string; body?: unknown };

function fakeEconomic(answer: (method: string, path: string) => Response | undefined) {
  const requests: Seen[] = [];
  const gateway = createEconomicGateway({
    appSecretToken: 'app-secret-for-tests',
    policy: { enableWrites: true },
    fetchImpl: (async (input: string | URL | Request, init?: RequestInit) => {
      const request = new Request(input, init);
      const path = new URL(request.url).pathname;
      const text = request.method === 'GET' ? '' : await request.clone().text();
      requests.push({ method: request.method, path, ...(text ? { body: JSON.parse(text) } : {}) });
      return answer(request.method, path) ?? Response.json({ ok: true });
    }) as typeof fetch,
  });
  return { gateway, requests };
}

const notFound = () => new Response('{}', { status: 404 });

/** A draft as e-conomic answers GET /{quotes|orders}/drafts/{n}, links and computed amounts included. */
function draftOf(kind: 'quote' | 'order', number: number): GatewayJsonObject {
  const base = `https://restapi.e-conomic.com/${kind}s/drafts/${number}`;
  return {
    [`${kind}Number`]: number,
    self: base,
    pdf: { download: `${base}/pdf` },
    templates: { upgradeInstructions: `${base}/templates/upgrade-instructions`, self: `${base}/templates` },
    soap: { [`${kind}Handle`]: { id: number } },
    lastUpdated: '2026-03-01T10:00:00Z',
    date: '2026-03-01',
    dueDate: '2026-03-31',
    currency: 'DKK',
    exchangeRate: 100,
    netAmount: 400,
    grossAmount: 500,
    vatAmount: 100,
    marginInBaseCurrency: 150,
    paymentTerms: { paymentTermsNumber: 1, name: 'Netto 8 dage', daysOfCredit: 8, paymentTermsType: 'net', self: 'https://restapi.e-conomic.com/payment-terms/1' },
    customer: { customerNumber: 1001, self: 'https://restapi.e-conomic.com/customers/1001' },
    recipient: {
      name: 'Eksempel Kunde A/S',
      address: 'Eksempelvej 1',
      zip: '1000',
      city: 'Byen',
      attention: { customerContactNumber: 4, self: 'https://restapi.e-conomic.com/customers/1001/contacts/4' },
      vatZone: { vatZoneNumber: 1, name: 'Domestic', self: 'https://restapi.e-conomic.com/vat-zones/1' },
    },
    deliveryLocation: { deliveryLocationNumber: 2, self: 'https://restapi.e-conomic.com/customers/1001/delivery-locations/2' },
    delivery: { address: 'Lagervej 2', zip: '1000', city: 'Byen', country: 'Danmark' },
    notes: { heading: 'Tilbud', textLine1: 'Linje et', textLine2: 'Linje to' },
    references: {
      other: 'Gammel reference',
      customerContact: { customerContactNumber: 4, self: 'https://restapi.e-conomic.com/customers/1001/contacts/4' },
      salesPerson: { employeeNumber: 1, self: 'https://restapi.e-conomic.com/employees/1' },
    },
    layout: { layoutNumber: 19, self: 'https://restapi.e-conomic.com/layouts/19' },
    lines: [
      {
        lineNumber: 1,
        description: 'Timer',
        product: { productNumber: 'P1', self: 'https://restapi.e-conomic.com/products/P1' },
        unit: { unitNumber: 1, name: 'timer', self: 'https://restapi.e-conomic.com/units/1' },
        quantity: 4,
        unitNetPrice: 100,
        totalNetAmount: 400,
        marginInBaseCurrency: 150,
        marginPercentage: 37.5,
      },
    ],
  };
}

const otherCustomer = {
  customerNumber: 2002,
  name: 'Anden Kunde ApS',
  currency: 'EUR',
  paymentTerms: { paymentTermsNumber: 3 },
  vatZone: { vatZoneNumber: 2 },
};

/** e-conomic with draft quote 5 and draft order 6; neither sent nor archived unless said. */
function economicWith(options: { sent?: string; archived?: string } = {}) {
  return fakeEconomic((method, path) => {
    if (method !== 'GET') return undefined;
    if (path === '/quotes/drafts/5') return Response.json(draftOf('quote', 5));
    if (path === '/orders/drafts/6') return Response.json(draftOf('order', 6));
    if (path === '/customers/2002') return Response.json(otherCustomer);
    if (options.sent && path === options.sent) return Response.json({ number: 1 });
    if (options.archived && path === options.archived) return Response.json({ number: 1 });
    return notFound();
  });
}

const puts = (requests: Seen[]) => requests.filter(request => request.method !== 'GET');

describe('update_draft_quote and update_draft_order', () => {
  it('changes a draft quote: read, status checked, merged and put back with its writable fields only', async () => {
    const { gateway, requests } = economicWith();
    const result = await gateway.callTool('update_draft_quote', {
      quoteNumber: 5,
      date: '2026-03-02',
      reference: 'PO 12',
      notes: { heading: 'Nyt tilbud' },
    }, context);
    expect(result.isError, result.content[0]?.text).toBeUndefined();
    expect(result.content[0]?.text.split('\n\n')[0]).toBe('Changed draft quote 5. Not sent.');
    expect(requests.filter(request => request.method === 'GET').map(request => request.path)).toEqual([
      '/quotes/drafts/5',
      '/quotes/sent/5',
      '/quotes/archived/5',
    ]);
    expect(puts(requests)).toHaveLength(1);
    const put = puts(requests)[0]!;
    expect(put.method).toBe('PUT');
    expect(put.path).toBe('/quotes/drafts/5');
    expect(put.body).toEqual({
      date: '2026-03-02',
      dueDate: '2026-03-31',
      currency: 'DKK',
      exchangeRate: 100,
      paymentTerms: { paymentTermsNumber: 1 },
      customer: { customerNumber: 1001 },
      recipient: {
        name: 'Eksempel Kunde A/S',
        address: 'Eksempelvej 1',
        zip: '1000',
        city: 'Byen',
        attention: { customerContactNumber: 4 },
        vatZone: { vatZoneNumber: 1 },
      },
      deliveryLocation: { deliveryLocationNumber: 2 },
      delivery: { address: 'Lagervej 2', zip: '1000', city: 'Byen', country: 'Danmark' },
      notes: { heading: 'Nyt tilbud', textLine1: 'Linje et', textLine2: 'Linje to' },
      references: { other: 'PO 12', customerContact: { customerContactNumber: 4 }, salesPerson: { employeeNumber: 1 } },
      layout: { layoutNumber: 19 },
      // e-conomic requires the unit's name on a line with a unit.
      lines: [{ lineNumber: 1, description: 'Timer', unit: { unitNumber: 1, name: 'timer' }, product: { productNumber: 'P1' }, quantity: 4, unitNetPrice: 100 }],
    });
    expect(JSON.stringify(put.body)).not.toMatch(/self|netAmount|grossAmount|vatAmount|margin|soap|templates|pdf|lastUpdated|daysOfCredit|Netto/);
  });

  it('changes a draft order: all its lines replaced, the rest kept', async () => {
    const { gateway, requests } = economicWith();
    const result = await gateway.callTool('update_draft_order', {
      orderNumber: 6,
      dueDate: '2026-04-15',
      lines: [{ productNumber: 'P1', quantity: 3 }, { productNumber: 'P2', quantity: 1, unitNetPrice: 50, description: 'Kørsel' }],
    }, context);
    expect(result.isError, result.content[0]?.text).toBeUndefined();
    expect(result.content[0]?.text.split('\n\n')[0]).toBe('Changed draft order 6. Not sent.');
    expect(requests.filter(request => request.method === 'GET').map(request => request.path)).toEqual([
      '/orders/drafts/6',
      '/orders/sent/6',
      '/orders/archived/6',
    ]);
    const put = puts(requests)[0]!;
    expect(put.path).toBe('/orders/drafts/6');
    const body = put.body as GatewayJsonObject;
    expect(body.dueDate).toBe('2026-04-15');
    expect(body.date).toBe('2026-03-01');
    expect(body.customer).toEqual({ customerNumber: 1001 });
    expect(body.layout).toEqual({ layoutNumber: 19 });
    expect(body.lines).toEqual([
      { lineNumber: 1, product: { productNumber: 'P1' }, quantity: 3 },
      { lineNumber: 2, product: { productNumber: 'P2' }, quantity: 1, description: 'Kørsel', unitNetPrice: 50 },
    ]);
  });

  it('refuses a draft that is not there, or that is sent or archived; nothing is put', async () => {
    const gone = fakeEconomic(() => notFound());
    const missing = await gone.gateway.callTool('update_draft_quote', { quoteNumber: 5, reference: 'PO 12' }, context);
    expect(missing.isError).toBe(true);
    expect(missing.content[0]?.text).toBe('The draft quote 5 does not exist (sent, archived, deleted, or never there). Nothing was changed.');
    expect(missing.failure).toMatchObject({ httpStatus: 404 });
    expect(puts(gone.requests)).toEqual([]);

    const goneOrder = fakeEconomic(() => notFound());
    expect((await goneOrder.gateway.callTool('update_draft_order', { orderNumber: 6, date: '2026-03-02' }, context)).content[0]?.text)
      .toBe('The draft order 6 does not exist (sent, archived, deleted, or never there). Nothing was changed.');
    expect(puts(goneOrder.requests)).toEqual([]);

    for (const [tool, input, state, text] of [
      ['update_draft_quote', { quoteNumber: 5, reference: 'R' }, { sent: '/quotes/sent/5' }, 'The draft quote 5 is sent. Nothing was changed.'],
      ['update_draft_quote', { quoteNumber: 5, reference: 'R' }, { archived: '/quotes/archived/5' }, 'The draft quote 5 is archived. Nothing was changed.'],
      ['update_draft_order', { orderNumber: 6, reference: 'R' }, { sent: '/orders/sent/6' }, 'The draft order 6 is sent. Nothing was changed.'],
      ['update_draft_order', { orderNumber: 6, reference: 'R' }, { archived: '/orders/archived/6' }, 'The draft order 6 is archived. Nothing was changed.'],
    ] as const) {
      const { gateway, requests } = economicWith(state);
      const result = await gateway.callTool(tool, input as GatewayJsonObject, context);
      expect(result.isError, text).toBe(true);
      expect(result.content[0]?.text).toBe(text);
      expect(puts(requests)).toEqual([]);
    }
  });

  it('refuses when e-conomic answers with another document, and bad input before anything is read', async () => {
    const wrong = fakeEconomic((method, path) => (method === 'GET' && path === '/quotes/drafts/5' ? Response.json(draftOf('quote', 9)) : notFound()));
    expect((await wrong.gateway.callTool('update_draft_quote', { quoteNumber: 5, reference: 'R' }, context)).content[0]?.text)
      .toBe('e-conomic did not answer with the draft quote 5. Nothing was changed.');
    expect(puts(wrong.requests)).toEqual([]);

    const { gateway, requests } = economicWith();
    for (const input of [
      { quoteNumber: 5 },
      { quoteNumber: 0, reference: 'R' },
      { quoteNumber: 5, date: '1. marts' },
      { quoteNumber: 5, currency: 'kroner' },
      { quoteNumber: 5, customerNumber: -1 },
      { quoteNumber: 5, lines: [] },
      { quoteNumber: 5, lines: [{ quantity: 1 }] },
      { quoteNumber: 5, notes: {} },
      { quoteNumber: 5, reference: 'x'.repeat(251) },
      { quoteNumber: 5, layoutNumber: 3 },
      { orderNumber: 6, reference: 'R' },
    ] as GatewayJsonObject[]) {
      expect((await gateway.callTool('update_draft_quote', input, context)).isError, JSON.stringify(input)).toBe(true);
    }
    expect(requests).toEqual([]);
  });

  it('keeps the draft’s customer unless customerNumber is given', async () => {
    // Recipient name, VAT zone, currency and terms change on the same customer: the customer stays.
    const same = economicWith();
    const result = await same.gateway.callTool('update_draft_quote', {
      quoteNumber: 5,
      recipientName: 'Eksempel Kunde A/S, afdeling Nord',
      vatZoneNumber: 2,
      currency: 'EUR',
      paymentTermsNumber: 3,
    }, context);
    expect(result.isError, result.content[0]?.text).toBeUndefined();
    const body = puts(same.requests)[0]!.body as GatewayJsonObject;
    expect(body.customer).toEqual({ customerNumber: 1001 });
    expect(body.recipient).toMatchObject({ name: 'Eksempel Kunde A/S, afdeling Nord', address: 'Eksempelvej 1', vatZone: { vatZoneNumber: 2 } });
    expect(body.currency).toBe('EUR');
    expect(body.paymentTerms).toEqual({ paymentTermsNumber: 3 });
    expect(same.requests.some(request => request.path.startsWith('/customers/'))).toBe(false);

    // The same customer number given is no move.
    const unchanged = economicWith();
    await unchanged.gateway.callTool('update_draft_quote', { quoteNumber: 5, customerNumber: 1001, reference: 'R' }, context);
    expect((puts(unchanged.requests)[0]!.body as GatewayJsonObject).customer).toEqual({ customerNumber: 1001 });
    expect(unchanged.requests.some(request => request.path.startsWith('/customers/'))).toBe(false);
  });

  it('moves the draft to another customer only when customerNumber says so, and leaves nothing of the old customer behind', async () => {
    const { gateway, requests } = economicWith();
    const result = await gateway.callTool('update_draft_order', { orderNumber: 6, customerNumber: 2002 }, context);
    expect(result.isError, result.content[0]?.text).toBeUndefined();
    expect(result.content[0]?.text.split('\n\n')[0]).toBe('Changed draft order 6 and moved it from customer 1001 to customer 2002. Not sent.');
    expect(requests.some(request => request.method === 'GET' && request.path === '/customers/2002')).toBe(true);
    const body = puts(requests)[0]!.body as GatewayJsonObject;
    expect(body.customer).toEqual({ customerNumber: 2002 });
    expect(body.recipient).toEqual({ name: 'Anden Kunde ApS', vatZone: { vatZoneNumber: 2 } });
    expect(body.currency).toBe('EUR');
    expect(body.paymentTerms).toEqual({ paymentTermsNumber: 3 });
    expect(body.deliveryLocation).toBeUndefined();
    expect(body.delivery).toBeUndefined();
    expect(body.references).toEqual({ other: 'Gammel reference', salesPerson: { employeeNumber: 1 } });
    expect(JSON.stringify(body)).not.toMatch(/Eksempel Kunde|Eksempelvej|Lagervej|1001/);

    // A new customer that cannot be read: nothing is put.
    const missing = fakeEconomic((method, path) => (method === 'GET' && path === '/orders/drafts/6' ? Response.json(draftOf('order', 6)) : notFound()));
    expect((await missing.gateway.callTool('update_draft_order', { orderNumber: 6, customerNumber: 2002 }, context)).content[0]?.text)
      .toBe('Customer 2002 could not be read from e-conomic. Nothing was changed.');
    expect(puts(missing.requests)).toEqual([]);
  });

  it('logs the document number, the customer only when given, the dates and the line count', () => {
    expect(resolveEconomicChange('update_draft_quote', { quoteNumber: 5, date: '2026-03-02', lines: [{ productNumber: 'P1', quantity: 1 }] }))
      .toEqual({ ok: true, change: { tool: 'update_draft_quote', action: 'upsert', record: 'draft-quote', booking: false, values: { quoteNumber: 5, date: '2026-03-02', lineCount: 1 } } });
    expect(resolveEconomicChange('update_draft_order', { orderNumber: 6, customerNumber: 2002, reference: 'PO 12' }))
      .toEqual({ ok: true, change: { tool: 'update_draft_order', action: 'upsert', record: 'draft-order', booking: false, values: { orderNumber: 6, customerNumber: 2002 } } });
  });

  it('are write tools (not destructive), off by default, and declare their requests', () => {
    for (const name of ['update_draft_quote', 'update_draft_order']) {
      const entry = economicToolCatalog.find(tool => tool.name === name)!;
      expect(entry.riskLevel).toBe('write');
      expect(entry.enabledByDefault).toBe(false);
      expect(entry.upstream.filter(operation => operation.access === 'write').map(operation => `${operation.method} ${operation.path}`))
        .toEqual([`PUT /${name === 'update_draft_quote' ? 'quotes' : 'orders'}/drafts/{number}`]);
    }
  });
});

describe('the fence and quotes and orders', () => {
  it('lets a PUT of one draft quote or order through', () => {
    expect(fenceRule('PUT', '/quotes/drafts/5')).toBeUndefined();
    expect(fenceRule('PUT', '/orders/drafts/6')).toBeUndefined();
    expect(fenceRule('PUT', '/Orders/Drafts/6')).toBeUndefined();
  });

  it('refuses every other PUT or PATCH under /quotes and /orders', () => {
    for (const [method, path] of [
      ['PUT', '/quotes/sent/5'],
      ['PUT', '/quotes/archived/5'],
      ['PUT', '/orders/sent/6'],
      ['PUT', '/orders/archived/6'],
      ['PUT', '/Quotes/Sent/5'],
      ['PUT', '/%71uotes/sent/5'],
      ['PUT', '/quotes/drafts'],
      ['PUT', '/quotes/drafts/5/lines'],
      ['PUT', '/quotes/drafts/5/templates/upgrade-instructions/order'],
      ['PUT', '/orders/drafts/abc'],
      ['PUT', '/orders'],
      ['PATCH', '/quotes/drafts/5'],
      ['PATCH', '/orders/sent/6'],
    ] as const) {
      expect(fenceRule(method, path)?.reason, `${method} ${path}`).toMatch(/quote or order that is not a draft/);
    }
  });

  it('still refuses the PUTs it refused before', () => {
    for (const path of ['/self', '/accounts/1000', '/settings', '/suppliers/1/bankAccount']) {
      expect(fenceRule('PUT', path), path).toBeDefined();
    }
  });
});
