// Subscriptions in ./gateway (#68): reads, adding a subscriber, ending one,
// and a plain answer when the agreement has no subscription module.
import { describe, expect, it } from 'vitest';
import { createEconomicGateway, economicToolCatalog, resolveEconomicChange, type GatewayJsonObject } from '../src/gateway.js';

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
      return answer(request) ?? Response.json({ number: 31 });
    }) as typeof fetch,
  });
  return { gateway, requests };
}

const subscriber = {
  number: 3,
  subscriptionNumber: 1,
  customerNumber: 2,
  startDate: '2026-01-01',
  endDate: '2026-03-31',
  bookedInvoiceId: 88,
  draftDocumentId: 99,
  lastUpdated: '2026-01-01T10:00:00',
  objectVersion: 'v7',
};

describe('subscription_overview', () => {
  it('reads subscriptions, subscribers and lines', async () => {
    const { gateway, requests } = fakeEconomic(() => Response.json([]));
    for (const resource of ['Subscriptions', 'Subscribers', 'subscriptionlines']) {
      expect((await gateway.callTool('subscription_overview', { resource }, context)).isError, resource).toBeUndefined();
    }
    expect(requests.map(request => request.path)).toEqual([
      '/subscriptionsapi/v6.0.3/Subscriptions/paged',
      '/subscriptionsapi/v6.0.3/Subscribers/paged',
      '/subscriptionsapi/v6.0.3/subscriptionlines/paged',
    ]);
  });

  it('says plainly that the module is off when a request fails and /self has no subscription module', async () => {
    const { gateway, requests } = fakeEconomic(request =>
      new URL(request.url).pathname === '/self'
        ? Response.json({ application: { requiredRoles: [{ roleNumber: 2, name: 'SuperUser' }] }, modules: [{ moduleNumber: 4, name: 'Projektstyring' }] })
        : new Response('{"message":"Forbidden"}', { status: 403 }));
    const result = await gateway.callTool('subscription_overview', {}, context);
    expect(result).toMatchObject({
      isError: true,
      content: [{ text: 'The Subscription module is not enabled for this agreement in e-conomic. It must be turned on in e-conomic before this can be used.' }],
    });
    expect(requests.map(request => request.path)).toEqual(['/subscriptionsapi/v6.0.3/Subscriptions/paged', '/self']);
  });

  it('keeps a refused access (401) as e-conomic’s own error and does not ask /self', async () => {
    const { gateway, requests } = fakeEconomic(request =>
      new URL(request.url).pathname === '/self'
        ? Response.json({ modules: [] })
        : new Response('{"message":"Unauthorized"}', { status: 401, headers: { 'content-type': 'application/json' } }));
    const result = await gateway.callTool('subscription_overview', {}, context);
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('HTTP 401');
    expect(result.content[0]?.text).not.toContain('module');
    expect(requests.map(request => request.path)).toEqual(['/subscriptionsapi/v6.0.3/Subscriptions/paged']);
  });

  it('keeps e-conomic’s own error when the module is on', async () => {
    const { gateway } = fakeEconomic(request =>
      new URL(request.url).pathname === '/self'
        ? Response.json({ modules: [{ moduleNumber: 74, name: 'Subscription and Direct Debit' }] })
        : new Response('{"message":"Something else"}', { status: 400, headers: { 'content-type': 'application/json' } }));
    const result = await gateway.callTool('subscription_overview', {}, context);
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('HTTP 400');
  });

  it('declares the read of /self in its upstream', () => {
    const upstream = economicToolCatalog.find(tool => tool.name === 'subscription_overview')!.upstream;
    expect(upstream.at(-1)).toEqual({ access: 'read', method: 'GET', path: '/self', serviceId: 'rest', resource: 'self' });
  });
});

describe('add_subscriber', () => {
  it('posts a subscriber with the given dates, and logs numbers and dates only', async () => {
    const { gateway, requests } = fakeEconomic();
    const input = { subscriptionNumber: 1, customerNumber: 2, startDate: '2026-01-01', endDate: '2026-03-31', discountPercentage: 10 };
    const result = await gateway.callTool('add_subscriber', input, context);
    expect(result.isError, result.content[0]?.text).toBeUndefined();
    expect(requests).toEqual([
      { method: 'POST', path: '/subscriptionsapi/v6.0.3/Subscribers', body: { subscriptionNumber: 1, customerNumber: 2, startDate: '2026-01-01', endDate: '2026-03-31', discountPercentage: 10 } },
    ]);
    expect(resolveEconomicChange('add_subscriber', input)).toMatchObject({
      ok: true,
      change: { action: 'create', record: 'subscriber', values: { subscriptionNumber: 1, customerNumber: 2, startDate: '2026-01-01', endDate: '2026-03-31' } },
    });
  });

  it('refuses bad dates and figures before anything is sent', async () => {
    const { gateway, requests } = fakeEconomic();
    for (const input of [
      { subscriptionNumber: 1, customerNumber: 2, startDate: '2026-02-01', endDate: '2026-01-31' },
      { subscriptionNumber: 1, customerNumber: 2, startDate: '2026-01-01', endDate: '2026-03-31', expiryDate: '2025-12-31' },
      { subscriptionNumber: 1, customerNumber: 2, startDate: '2026-01-01', endDate: '2026-03-31', discountPercentage: 120 },
      { subscriptionNumber: 1, customerNumber: 2, startDate: 'i morgen', endDate: '2026-03-31' },
    ] as GatewayJsonObject[]) {
      expect((await gateway.callTool('add_subscriber', input, context)).isError, JSON.stringify(input)).toBe(true);
    }
    expect(requests).toEqual([]);
  });
});

describe('end_subscriber', () => {
  it('sets the expiry date on the subscriber and deletes nothing', async () => {
    const { gateway, requests } = fakeEconomic(request => (request.method === 'GET' ? Response.json(subscriber) : undefined));
    const result = await gateway.callTool('end_subscriber', { subscriberNumber: 3, expiryDate: '2026-06-30' }, context);
    expect(result.isError, result.content[0]?.text).toBeUndefined();
    expect(result.content[0]?.text.split('\n\n')[0]).toBe('Subscriber 3 ends on 2026-06-30.');
    expect(requests).toEqual([
      { method: 'GET', path: '/subscriptionsapi/v6.0.3/Subscribers/3' },
      {
        method: 'PUT',
        path: '/subscriptionsapi/v6.0.3/Subscribers',
        body: { number: 3, subscriptionNumber: 1, customerNumber: 2, startDate: '2026-01-01', endDate: '2026-03-31', objectVersion: 'v7', expiryDate: '2026-06-30' },
      },
    ]);
    expect(requests.some(request => request.method === 'DELETE')).toBe(false);
  });

  it('refuses an expiry date before the start, and an unknown subscriber', async () => {
    const early = fakeEconomic(request => (request.method === 'GET' ? Response.json(subscriber) : undefined));
    expect((await early.gateway.callTool('end_subscriber', { subscriberNumber: 3, expiryDate: '2025-12-31' }, context)).isError).toBe(true);
    expect(early.requests.some(request => request.method === 'PUT')).toBe(false);
    const unknown = fakeEconomic(request => (request.method === 'GET' && new URL(request.url).pathname !== '/self'
      ? new Response('{}', { status: 404 })
      : Response.json({ modules: [{ name: 'Subscription and Direct Debit' }] })));
    expect((await unknown.gateway.callTool('end_subscriber', { subscriberNumber: 9, expiryDate: '2026-06-30' }, context)).content[0]?.text)
      .toBe('Subscriber 9 does not exist.');
  });
});
