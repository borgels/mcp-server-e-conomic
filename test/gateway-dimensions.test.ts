// Dimensions in ./gateway (#69): reads, and setting a value on a draft entry
// or a sales document line. No dimensions or values are created or deleted.
import { describe, expect, it } from 'vitest';
import { createEconomicGateway, economicToolCatalog, resolveEconomicChange, type GatewayJsonObject } from '../src/gateway.js';

const context = { credentials: { agreementGrantToken: 'grant-token-for-tests' } };

function fakeEconomic(answer: (request: Request) => Response | undefined = () => undefined, enableWrites = true) {
  const requests: Array<{ method: string; path: string; filter: string | null; body?: unknown }> = [];
  const gateway = createEconomicGateway({
    appSecretToken: 'app-secret-for-tests',
    policy: { enableWrites },
    fetchImpl: (async (input: string | URL | Request, init?: RequestInit) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      const text = request.method === 'GET' ? '' : await request.clone().text();
      requests.push({ method: request.method, path: url.pathname, filter: url.searchParams.get('filter'), ...(text ? { body: JSON.parse(text) } : {}) });
      return answer(request) ?? Response.json({ items: [] });
    }) as typeof fetch,
  });
  return { gateway, requests };
}

const base = '/dimensionsapi/v5.3.1';

describe('dimension_overview', () => {
  it('reads dimensions, values and the dimension data on entries and lines', async () => {
    const { gateway, requests } = fakeEconomic(() => Response.json([]));
    for (const resource of ['dimensions', 'values', 'dimension-data/booked-entries', 'dimension-data/draft-entries']) {
      expect((await gateway.callTool('dimension_overview', { resource }, context)).isError, resource).toBeUndefined();
    }
    expect(requests.map(request => request.path)).toEqual([
      `${base}/dimensions/paged`,
      `${base}/values/paged`,
      `${base}/dimension-data/booked-entries/paged`,
      `${base}/dimension-data/draft-entries/paged`,
    ]);
  });
});

describe('set_entry_dimensions', () => {
  it('adds a dimension value to a draft entry that has none', async () => {
    const { gateway, requests } = fakeEconomic();
    const input = { target: 'draftEntry', journalNumber: 3, entryNumber: 27, dimensionNumber: 1, dimensionKey: 2 };
    const result = await gateway.callTool('set_entry_dimensions', input, context);
    expect(result.isError, result.content[0]?.text).toBeUndefined();
    expect(result.content[0]?.text.split('\n\n')[0]).toBe('Set dimension 1 to 2 on draft entry 27 in journal 3.');
    expect(requests).toEqual([
      { method: 'GET', path: `${base}/dimension-data/draft-entries`, filter: 'journalNumber$eq:3$and:entryNumber$eq:27$and:dimensionNumber$eq:1' },
      {
        method: 'POST',
        path: `${base}/dimension-data/draft-entries`,
        filter: null,
        body: { journalNumber: 3, entryNumber: 27, dimensionNumber: 1, dimensionKey: 2, isDistribution: false },
      },
    ]);
  });

  it('changes the value already set on a sales line, with its objectVersion', async () => {
    const { gateway, requests } = fakeEconomic(request =>
      request.method === 'GET'
        ? Response.json({ items: [{ documentNumber: 7, lineNumber: 1, dimensionNumber: 1, dimensionKey: 1, objectVersion: 'v3' }] })
        : undefined);
    const input = { target: 'salesDocumentLine', documentNumber: 7, lineNumber: 1, dimensionNumber: 1, dimensionKey: 4 };
    const result = await gateway.callTool('set_entry_dimensions', input, context);
    expect(result.content[0]?.text.split('\n\n')[0]).toBe('Changed dimension 1 to 4 on line 1 of sales document 7.');
    expect(requests.at(-1)).toEqual({
      method: 'PUT',
      path: `${base}/dimension-data/sales-document-lines`,
      filter: null,
      body: { documentNumber: 7, lineNumber: 1, dimensionNumber: 1, dimensionKey: 4, isDistribution: false, objectVersion: 'v3' },
    });
  });

  it('refuses mixed or missing keys before anything is read', async () => {
    const { gateway, requests } = fakeEconomic();
    for (const input of [
      { target: 'draftEntry', journalNumber: 3, dimensionNumber: 1, dimensionKey: 2 },
      { target: 'draftEntry', journalNumber: 3, entryNumber: 27, lineNumber: 1, dimensionNumber: 1, dimensionKey: 2 },
      { target: 'salesDocumentLine', documentNumber: 7, dimensionNumber: 1, dimensionKey: 2 },
      { target: 'bookedEntry', journalNumber: 3, entryNumber: 27, dimensionNumber: 1, dimensionKey: 2 },
    ] as GatewayJsonObject[]) {
      expect((await gateway.callTool('set_entry_dimensions', input, context)).isError, JSON.stringify(input)).toBe(true);
    }
    expect(requests).toEqual([]);
  });

  it('logs numbers only, and never creates or deletes dimensions or values', () => {
    expect(resolveEconomicChange('set_entry_dimensions', { target: 'draftEntry', journalNumber: 3, entryNumber: 27, dimensionNumber: 1, dimensionKey: 2 }))
      .toMatchObject({ ok: true, change: { values: { target: 'draftEntry', journalNumber: 3, entryNumber: 27, dimensionNumber: 1, dimensionKey: 2 } } });
    const writes = economicToolCatalog.flatMap(tool => tool.upstream.filter(operation => operation.access === 'write'));
    expect(writes.some(operation => /\/(dimensions|values|distributions)$/.test(operation.path))).toBe(false);
    expect(writes.some(operation => operation.path.includes('dimension-data/booked'))).toBe(false);
  });
});
