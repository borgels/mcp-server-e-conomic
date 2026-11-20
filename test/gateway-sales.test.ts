// Quotes and orders in ./gateway (#64): narrow reads, drafts, and upgrades
// from quote to order or draft invoice. Nothing is sent or deleted.
import { describe, expect, it } from 'vitest';
import {
  createEconomicGateway,
  economicServiceCatalog,
  economicToolCatalog,
  resolveEconomicChange,
  resolveEconomicReadTarget,
  type GatewayJsonObject,
} from '../src/gateway.js';

const context = { credentials: { agreementGrantToken: 'grant-token-for-tests' } };

function fakeEconomic(answer: (request: Request) => Response, enableWrites = true) {
  const requests: Array<{ method: string; path: string; body?: unknown }> = [];
  const gateway = createEconomicGateway({
    appSecretToken: 'app-secret-for-tests',
    policy: { enableWrites },
    fetchImpl: (async (input: string | URL | Request, init?: RequestInit) => {
      const request = new Request(input, init);
      const text = request.method === 'GET' ? '' : await request.clone().text();
      requests.push({ method: request.method, path: new URL(request.url).pathname, ...(text ? { body: JSON.parse(text) } : {}) });
      return answer(request);
    }) as typeof fetch,
  });
  return { gateway, requests };
}

const customer = { name: 'Kunde A/S', currency: 'DKK', paymentTerms: { paymentTermsNumber: 1 }, vatZone: { vatZoneNumber: 1 } };

describe('quote_overview and order_overview', () => {
  it('read the REST quote and order collections, drafts by default', async () => {
    const { gateway, requests } = fakeEconomic(() => Response.json({ collection: [{ quoteNumber: 1 }] }));
    expect((await gateway.callTool('quote_overview', {}, context)).isError).toBeUndefined();
    expect((await gateway.callTool('quote_overview', { resource: 'quotes/sent' }, context)).isError).toBeUndefined();
    expect((await gateway.callTool('order_overview', { number: 16 }, context)).isError).toBeUndefined();
    expect((await gateway.callTool('order_overview', { resource: 'orders/archived' }, context)).isError).toBeUndefined();
    expect(requests.map(request => request.path)).toEqual(['/quotes/drafts', '/quotes/sent', '/orders/drafts/16', '/orders/archived']);
  });

  it('read nothing else', () => {
    expect(resolveEconomicReadTarget('quote_overview', { resource: 'invoices/booked' }).ok).toBe(false);
    expect(resolveEconomicReadTarget('order_overview', { resource: 'quotes/drafts' }).ok).toBe(false);
    const upstream = economicToolCatalog.find(tool => tool.name === 'quote_overview')!.upstream;
    expect(upstream.every(operation => operation.method === 'GET' && operation.path.startsWith('/quotes/'))).toBe(true);
  });
});

describe('create_draft_quote and create_draft_order', () => {
  for (const [tool, path, noun] of [
    ['create_draft_quote', '/quotes/drafts', 'draft quote'],
    ['create_draft_order', '/orders/drafts', 'draft order'],
  ] as const) {
    it(`${tool} posts a draft built like a draft invoice to ${path}`, async () => {
      const { gateway, requests } = fakeEconomic(request => {
        const where = new URL(request.url).pathname;
        if (where === '/customers/1001') return Response.json(customer);
        if (where === '/layouts') return Response.json({ collection: [{ layoutNumber: 19 }] });
        return Response.json({ number: 5 });
      });
      const result = await gateway.callTool(tool, {
        customerNumber: 1001,
        date: '2026-05-04',
        lines: [{ productNumber: 'P1', quantity: 2, unitNetPrice: 100 }],
      }, context);
      expect(result.isError).toBeUndefined();
      expect(result.content[0]?.text.split('\n\n')[0]).toBe(`Created e-conomic ${noun}.`);
      const post = requests.find(request => request.method === 'POST');
      expect(post).toMatchObject({
        path,
        body: {
          date: '2026-05-04',
          currency: 'DKK',
          customer: { customerNumber: 1001 },
          layout: { layoutNumber: 19 },
          lines: [{ lineNumber: 1, product: { productNumber: 'P1' }, quantity: 2, unitNetPrice: 100 }],
        },
      });
    });
  }

  it('logs only numbers, currency and date, plus the line count', () => {
    expect(resolveEconomicChange('create_draft_quote', {
      customerNumber: 1001,
      currency: 'DKK',
      date: '2026-05-04',
      recipientName: 'Kunde A/S',
      lines: [{ productNumber: 'P1', quantity: 1, description: 'Fri tekst' }],
    })).toEqual({
      ok: true,
      change: {
        tool: 'create_draft_quote',
        action: 'create',
        record: 'draft-quote',
        booking: false,
        values: { customerNumber: 1001, currency: 'DKK', date: '2026-05-04', lineCount: 1 },
      },
    });
  });
});

describe('upgrade_quote and upgrade_order', () => {
  function templates(request: Request): Response {
    const where = new URL(request.url).pathname;
    if (where === '/quotes/drafts/17/templates/upgrade-instructions/order') {
      return Response.json({ order: { quoteNumber: 17, customer: { customerNumber: 2 }, lines: [] } });
    }
    if (where === '/quotes/drafts/17/templates/upgrade-instructions/draftInvoice') {
      return Response.json({ draftInvoice: { quoteNumber: 17, customer: { customerNumber: 2 } } });
    }
    if (where === '/orders/drafts/16/templates/upgrade-instructions/draftInvoice') {
      return Response.json({ draftInvoice: { orderNumber: 16, customer: { customerNumber: 1 } } });
    }
    if (where === '/orders/drafts' && request.method === 'POST') return Response.json({ orderNumber: 18 });
    if (where === '/invoices/drafts' && request.method === 'POST') return Response.json({ draftInvoiceNumber: 31 });
    return new Response('{"message":"not found"}', { status: 404 });
  }

  it('posts e-conomic’s upgrade template for a quote to the draft orders', async () => {
    const { gateway, requests } = fakeEconomic(templates);
    const result = await gateway.callTool('upgrade_quote', { quoteNumber: 17, to: 'order' }, context);
    expect(result.isError).toBeUndefined();
    expect(result.content[0]?.text.split('\n\n')[0]).toBe('Turned draft quote 17 into draft order 18. Not booked or sent.');
    expect(requests).toEqual([
      { method: 'GET', path: '/quotes/drafts/17/templates/upgrade-instructions/order' },
      { method: 'POST', path: '/orders/drafts', body: { quoteNumber: 17, customer: { customerNumber: 2 }, lines: [] } },
    ]);
  });

  it('turns a quote or an order into a draft invoice', async () => {
    const { gateway, requests } = fakeEconomic(templates);
    expect((await gateway.callTool('upgrade_quote', { quoteNumber: 17, to: 'draftInvoice' }, context)).isError).toBeUndefined();
    const order = await gateway.callTool('upgrade_order', { orderNumber: 16 }, context);
    expect(order.content[0]?.text.split('\n\n')[0]).toBe('Turned draft order 16 into draft invoice 31. Not booked or sent.');
    expect(requests.filter(request => request.method === 'POST').map(request => request.path)).toEqual(['/invoices/drafts', '/invoices/drafts']);
  });

  it('answers clearly when the draft does not exist, and posts nothing', async () => {
    const { gateway, requests } = fakeEconomic(templates);
    const result = await gateway.callTool('upgrade_order', { orderNumber: 99 }, context);
    expect(result).toMatchObject({ isError: true, content: [{ text: 'Draft order 99 does not exist.' }] });
    expect(requests.some(request => request.method === 'POST')).toBe(false);
  });

  it('reads no template when writes are off', async () => {
    const { gateway, requests } = fakeEconomic(templates, false);
    const result = await gateway.callTool('upgrade_quote', { quoteNumber: 17, to: 'order' }, context);
    expect(result.isError).toBe(true);
    expect(requests).toEqual([]);
  });

  it('refuses a bad target before anything is read', async () => {
    const { gateway, requests } = fakeEconomic(templates);
    for (const input of [{ quoteNumber: 17, to: 'sent' }, { quoteNumber: 0, to: 'order' }] as GatewayJsonObject[]) {
      expect((await gateway.callTool('upgrade_quote', input, context)).isError).toBe(true);
    }
    expect(requests).toEqual([]);
  });

  it('logs the source number and the target', () => {
    expect(resolveEconomicChange('upgrade_quote', { quoteNumber: 17, to: 'order' })).toMatchObject({
      ok: true,
      change: { action: 'create', record: 'upgraded-quote', values: { quoteNumber: 17, to: 'order' } },
    });
    expect(resolveEconomicChange('upgrade_order', { orderNumber: 16 })).toMatchObject({
      ok: true,
      change: { record: 'upgraded-order', values: { orderNumber: 16 } },
    });
  });
});

describe('no sending and no deleting of quotes and orders', () => {
  it('has no write endpoint for sent quotes or orders and no DELETE of drafts', () => {
    const writes = economicServiceCatalog.endpoints.filter(
      endpoint => endpoint.serviceId === 'rest' && endpoint.access === 'write' && /^\/(quotes|orders)\//.test(endpoint.pathTemplate),
    );
    expect(writes.map(endpoint => `${endpoint.method} ${endpoint.pathTemplate}`).sort()).toEqual([
      'POST /orders/drafts',
      'POST /quotes/drafts',
    ]);
    const tools = economicToolCatalog.filter(tool => /quote|order/.test(tool.name));
    for (const tool of tools) {
      for (const operation of tool.upstream.filter(item => item.access === 'write')) {
        expect(operation.path, tool.name).not.toMatch(/\/(sent|archived)/);
      }
    }
  });
});
