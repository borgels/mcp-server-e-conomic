// Deleting drafts and booking a whole journal through the embedded gateway (#88): what may be deleted is checked
// at e-conomic right before the DELETE, nothing is deleted when the check fails, and every other DELETE stays
// behind the fixed fence.
import { describe, expect, it, vi } from 'vitest';
import { EconomicClient, type HttpMethod } from '../src/economic/client.js';
import { SecretRedactor } from '../src/errors.js';
import { basePolicy, checkPolicy } from '../src/economic/policy.js';
import {
  GATEWAY_DELETABLE,
  createEconomicGateway,
  economicToolCatalog,
  fenceRule,
  resolveEconomicChange,
  type EconomicHostPolicy,
  type GatewayJsonObject,
} from '../src/gateway.js';

const context = { credentials: { agreementGrantToken: 'fake-grant-token-aaaabbbb' } };
const WRITES: EconomicHostPolicy = { enableWrites: true };
const BOOKING: EconomicHostPolicy = { enableWrites: true, allowBooking: true };

type Responder = (method: string, path: string) => Response | undefined;

function fakeEconomic(policy: EconomicHostPolicy | undefined, respond: Responder = () => undefined) {
  const requests: Array<{ method: string; path: string; body: unknown }> = [];
  const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(input, init);
    const text = request.method === 'GET' || request.method === 'DELETE' ? '' : await request.text();
    const path = new URL(request.url).pathname;
    requests.push({ method: request.method, path, body: text ? JSON.parse(text) : undefined });
    return respond(request.method, path) ?? defaultResponse(request.method, path);
  });
  const gateway = createEconomicGateway({
    appSecretToken: 'fake-app-secret-ccccdddd',
    fetchImpl: fetchImpl as unknown as typeof fetch,
    ...(policy ? { policy } : {}),
  });
  return {
    gateway,
    requests,
    deletes: () => requests.filter(request => request.method === 'DELETE'),
    writes: () => requests.filter(request => request.method !== 'GET'),
  };
}

function draftEntries(count: number, journalNumber = 1, first = 100) {
  return Array.from({ length: count }, (_, index) => ({
    entryNumber: first + index,
    journalNumber,
    voucherNumber: 900 + index,
    date: '2026-03-02T00:00:00',
    amount: index % 2 === 0 ? 100 : -100,
  }));
}

function defaultResponse(method: string, path: string): Response {
  if (method === 'GET' && /\/draft-entries\/11$/.test(path)) return Response.json({ entryNumber: 11, journalNumber: 1, amount: 100 });
  if (method === 'GET' && path.endsWith('/draft-entries')) {
    return Response.json({
      items: [
        { entryNumber: 11, journalNumber: 1, voucherNumber: 501, date: '2026-03-02T00:00:00', amount: -1250 },
        { entryNumber: 12, journalNumber: 1, voucherNumber: 501, date: '2026-03-02T00:00:00', amount: 1250 },
        { entryNumber: 21, journalNumber: 2, voucherNumber: 601, date: '2026-03-02T00:00:00', amount: 5 },
      ],
    });
  }
  if (method === 'GET' && path === '/accounting-years') {
    return Response.json({ collection: [{ year: '2026', fromDate: '2026-01-01', toDate: '2026-12-31' }] });
  }
  if (method === 'GET' && path.endsWith('/AttachedDocuments/501')) return Response.json({ voucherNumber: 501 });
  if (method === 'GET' && path === '/invoices/drafts/7') return Response.json({ draftInvoiceNumber: 7 });
  if (method === 'GET' && /\/TimeEntries\/5$/.test(path)) return Response.json({ number: 5, isApproved: false, isReconciled: false });
  if (method === 'GET') return new Response(JSON.stringify({ message: 'Not found' }), { status: 404 });
  if (method === 'DELETE') return new Response(null, { status: 204 });
  return Response.json({});
}

describe('the fence lets DELETE through only on a draft', () => {
  const allowed: Array<[string]> = [
    ['/journalsapi/v16.0.1/draft-entries/27'],
    ['/invoices/drafts/4'],
    ['/projectsapi/v1.1.1/TimeEntries/3'],
    ['/Invoices/Drafts/%34'],
  ];
  it.each(allowed)('allows DELETE %s', path => {
    expect(fenceRule('DELETE', path)).toBeUndefined();
  });

  const refused: Array<[HttpMethod, string]> = [
    ['DELETE', '/invoices/booked/70001'],
    ['DELETE', '/invoices/drafts/4/lines/1'],
    ['DELETE', '/invoices/drafts'],
    ['DELETE', '/invoices/drafts/4?x=1/'],
    ['DELETE', '/quotes/drafts/17'],
    ['DELETE', '/orders/drafts/16'],
    ['DELETE', '/journalsapi/v16.0.1/draft-entries/delete/3'],
    ['DELETE', '/journalsapi/v16.0.1/draft-entries'],
    ['DELETE', '/journalsapi/v16.0.1/journals/3'],
    ['DELETE', '/journals/3/entries/27'],
    ['DELETE', '/bookedEntriesapi/v7.0.0/booked-entries/1'],
    ['DELETE', '/customers/1'],
    ['DELETE', '/suppliers/1'],
    ['DELETE', '/products/P1'],
    ['DELETE', '/accounts/1000'],
    ['DELETE', '/projectsapi/v1.1.1/Projects/1'],
    ['DELETE', '/projectsapi/v1.1.1/Employees/1'],
    ['DELETE', '/projectsapi/v1.1.1/TimeEntries'],
    ['DELETE', '/documentsapi/v4.0.2/AttachedDocuments/1'],
    ['DELETE', '/documentsapi/v4.0.2/AttachedDocuments/deletebulk'],
    ['DELETE', '/self/user'],
    ['DELETE', '/webhooksapi/v1.0.0/webhooks/1'],
    ['POST', '/journalsapi/v16.0.1/journals/5/book'],
    ['POST', '/journalsapi/v16.0.1/journals/5/bookWithDateInterval'],
    ['PUT', '/self/company/bankinformation'],
    ['POST', '/accounting-years'],
    ['PUT', '/accounts/1000'],
    ['POST', '/users'],
    ['PUT', '/settings'],
  ];
  it.each(refused)('refuses %s %s', (method, path) => {
    expect(fenceRule(method, path)).toBeDefined();
  });

  it('refuses a fenced DELETE in the client before anything is sent', async () => {
    const fetchImpl = vi.fn(async () => Response.json({}));
    const client = new EconomicClient({
      appSecretToken: 'fake-app-secret-ccccdddd',
      agreementGrantToken: 'fake-grant-token-aaaabbbb',
      credentialEnv: {},
      redactor: new SecretRedactor(),
      fetchImpl: fetchImpl as unknown as typeof fetch,
      fence: true,
    });
    await expect(client.rest('/invoices/booked/70001', { method: 'DELETE' })).rejects.toThrow(/gateway fence/);
    await expect(client.rest('/customers/1', { method: 'DELETE' })).rejects.toThrow(/gateway fence/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('is a frozen list of three paths', () => {
    expect(Object.isFrozen(GATEWAY_DELETABLE)).toBe(true);
    expect(GATEWAY_DELETABLE).toHaveLength(3);
  });

  it('lets each delete tool reach only its own DELETE, and no other tool any DELETE', () => {
    for (const tool of economicToolCatalog) {
      const deletes = tool.upstream.filter(operation => operation.method === 'DELETE');
      if (tool.name.startsWith('delete_')) {
        expect(deletes, tool.name).toHaveLength(1);
        expect(tool.riskLevel, tool.name).toBe('write');
        expect(tool.change?.action, tool.name).toBe('delete');
        expect(tool.booking, tool.name).toBe(false);
      } else {
        expect(deletes, tool.name).toEqual([]);
      }
    }
  });
});

describe('the write policy for delete tools', () => {
  const policy = { ...basePolicy(), writesEnabled: true };

  it('allows a delete tool only on its own endpoint, with DELETE', () => {
    expect(checkPolicy({ capability: 'delete_draft_invoice', serviceId: 'rest', method: 'DELETE', path: '/invoices/drafts/7' }, policy).allowed).toBe(true);
    expect(checkPolicy({ capability: 'delete_draft_invoice', serviceId: 'rest', method: 'DELETE', path: '/invoices/booked/7' }, policy).allowed).toBe(false);
    expect(checkPolicy({ capability: 'delete_draft_invoice', serviceId: 'rest', method: 'POST', path: '/invoices/drafts/7' }, policy).allowed).toBe(false);
    expect(checkPolicy({ capability: 'delete_time_entry', serviceId: 'projects', method: 'DELETE', path: '/Projects/1' }, policy).allowed).toBe(false);
  });

  it('refuses every delete when writes are off, and any DELETE for another capability', () => {
    expect(checkPolicy({ capability: 'delete_draft_invoice', serviceId: 'rest', method: 'DELETE', path: '/invoices/drafts/7' }, basePolicy()).allowed).toBe(false);
    expect(checkPolicy({ capability: 'upsert_customer', serviceId: 'rest', method: 'DELETE', path: '/invoices/drafts/7' }, policy).allowed).toBe(false);
  });
});

describe('delete tools', () => {
  const cases: Array<[string, GatewayJsonObject, string[], string]> = [
    ['delete_journal_entry', { journalNumber: 1, entryNumber: 11 }, ['/journalsapi/v16.0.1/draft-entries/11'], '/journalsapi/v16.0.1/draft-entries/11'],
    ['delete_draft_invoice', { draftInvoiceNumber: 7 }, ['/invoices/drafts/7'], '/invoices/drafts/7'],
    ['delete_time_entry', { timeEntryNumber: 5 }, ['/projectsapi/v1.1.1/TimeEntries/5'], '/projectsapi/v1.1.1/TimeEntries/5'],
  ];

  it.each(cases)('%s reads the status, then deletes the one record', async (tool, input, reads, deleted) => {
    const { gateway, requests, deletes } = fakeEconomic(WRITES);
    const result = await gateway.callTool(tool, input, context);
    expect(result.isError, result.content[0]?.text).toBeUndefined();
    expect(requests.filter(request => request.method === 'GET').map(request => request.path)).toEqual(reads);
    expect(deletes().map(request => request.path)).toEqual([deleted]);
    expect(requests.at(-1)?.method).toBe('DELETE');
  });

  it.each(cases)('%s deletes nothing when writes are off', async (tool, input) => {
    const { gateway, requests } = fakeEconomic(undefined);
    const result = await gateway.callTool(tool, input, context);
    expect(result.isError).toBe(true);
    expect(requests).toEqual([]);
  });

  it.each(cases)('%s deletes nothing when the record is not found as a draft (404)', async (tool, input) => {
    const { gateway, deletes } = fakeEconomic(WRITES, method => (method === 'GET' ? new Response('', { status: 404 }) : undefined));
    const result = await gateway.callTool(tool, input, context);
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toMatch(/Nothing was deleted/);
    expect(deletes()).toEqual([]);
  });

  it.each(cases)('%s deletes nothing when the status cannot be read (500, or no body)', async (tool, input) => {
    for (const answer of [() => new Response('boom', { status: 500 }), () => new Response(null, { status: 200 })]) {
      const { gateway, deletes } = fakeEconomic(WRITES, method => (method === 'GET' ? answer() : undefined));
      const result = await gateway.callTool(tool, input, context);
      expect(result.isError, tool).toBe(true);
      expect(deletes(), tool).toEqual([]);
    }
  });

  it('refuses a draft entry of another journal, or an answer for another entry', async () => {
    for (const answer of [{ entryNumber: 11, journalNumber: 2 }, { entryNumber: 12, journalNumber: 1 }, { entryNumber: 11 }]) {
      const { gateway, deletes } = fakeEconomic(WRITES, (method, path) =>
        method === 'GET' && path.endsWith('/draft-entries/11') ? Response.json(answer) : undefined,
      );
      const result = await gateway.callTool('delete_journal_entry', { journalNumber: 1, entryNumber: 11 }, context);
      expect(result.isError, JSON.stringify(answer)).toBe(true);
      expect(deletes()).toEqual([]);
    }
  });

  it('refuses a time entry that is approved, reconciled, or of unknown status', async () => {
    for (const entry of [
      { number: 5, isApproved: true, isReconciled: false },
      { number: 5, isApproved: false, isReconciled: true },
      { number: 5, isApproved: false },
      { number: 5 },
      { number: 5, isApproved: 'false', isReconciled: 'false' },
    ]) {
      const { gateway, deletes } = fakeEconomic(WRITES, (method, path) => (method === 'GET' && path.endsWith('/TimeEntries/5') ? Response.json(entry) : undefined));
      const result = await gateway.callTool('delete_time_entry', { timeEntryNumber: 5 }, context);
      expect(result.isError, JSON.stringify(entry)).toBe(true);
      expect(deletes()).toEqual([]);
    }
  });

  it('refuses an answer that does not name the record asked for, or names none', async () => {
    const cases: Array<[string, GatewayJsonObject, RegExp]> = [
      ['delete_draft_invoice', { draftInvoiceNumber: 7 }, /^\/invoices\/drafts\/7$/],
      ['delete_time_entry', { timeEntryNumber: 5 }, /\/TimeEntries\/5$/],
    ];
    for (const [tool, input, statusPath] of cases) {
      for (const answer of [{}, { draftInvoiceNumber: 8, quoteNumber: 8, orderNumber: 8, number: 8, isApproved: false, isReconciled: false }]) {
        const { gateway, deletes } = fakeEconomic(WRITES, (method, path) => (method === 'GET' && statusPath.test(path) ? Response.json(answer) : undefined));
        const result = await gateway.callTool(tool, input, context);
        expect(result.isError, `${tool} ${JSON.stringify(answer)}`).toBe(true);
        expect(deletes(), tool).toEqual([]);
      }
    }
  });

  it('resolves a delete for the log: numbers only, action delete', () => {
    expect(resolveEconomicChange('delete_draft_invoice', { draftInvoiceNumber: 7 })).toEqual({
      ok: true,
      change: { tool: 'delete_draft_invoice', action: 'delete', record: 'draft-invoice', booking: false, values: { draftInvoiceNumber: 7 } },
    });
    expect(resolveEconomicChange('delete_journal_entry', { journalNumber: 1, entryNumber: 11 })).toMatchObject({
      ok: true,
      change: { action: 'delete', record: 'journal-entry', values: { journalNumber: 1, entryNumber: 11 } },
    });
  });

  it('answers in contract mode without a request', async () => {
    const gateway = createEconomicGateway({ contractMode: true, policy: WRITES });
    const result = await gateway.callTool('delete_time_entry', { timeEntryNumber: 5 }, context);
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toMatchObject({ mode: 'contract', action: 'deleted', timeEntryNumber: 5 });
  });
});

describe('book_journal', () => {
  it('books exactly the counted entries of the journal, and nothing from another journal', async () => {
    const { gateway, writes } = fakeEconomic(BOOKING);
    const result = await gateway.callTool('book_journal', { journalNumber: 1, entryCount: 2 }, context);
    expect(result.isError, result.content[0]?.text).toBeUndefined();
    expect(writes()).toEqual([
      { method: 'POST', path: '/journalsapi/v16.0.1/journals/1/bookdraftentries', body: { entryNumbers: [11, 12] } },
    ]);
  });

  it('books nothing when the journal holds another number of entries', async () => {
    for (const entryCount of [1, 3]) {
      const { gateway, writes } = fakeEconomic(BOOKING);
      const result = await gateway.callTool('book_journal', { journalNumber: 1, entryCount }, context);
      expect(result.isError).toBe(true);
      expect(result.content[0]?.text).toContain('holds 2 draft entries');
      expect(writes()).toEqual([]);
    }
  });

  it('books only the entries it counted, when an entry is added between its two reads', async () => {
    let reads = 0;
    const first = [
      { entryNumber: 11, journalNumber: 1, voucherNumber: 501, date: '2026-03-02T00:00:00', amount: -1250 },
      { entryNumber: 12, journalNumber: 1, voucherNumber: 501, date: '2026-03-02T00:00:00', amount: 1250 },
    ];
    const { gateway, writes } = fakeEconomic(BOOKING, (method, path) => {
      if (method !== 'GET' || !path.endsWith('/draft-entries')) return undefined;
      reads += 1;
      const added = { entryNumber: 13, journalNumber: 1, voucherNumber: 502, date: '2026-03-02T00:00:00', amount: 99 };
      return Response.json({ items: reads === 1 ? first : [...first, added] });
    });
    const result = await gateway.callTool('book_journal', { journalNumber: 1, entryCount: 2 }, context);
    expect(result.isError, result.content[0]?.text).toBeUndefined();
    expect(reads).toBeGreaterThanOrEqual(2);
    expect(writes()).toEqual([
      { method: 'POST', path: '/journalsapi/v16.0.1/journals/1/bookdraftentries', body: { entryNumbers: [11, 12] } },
    ]);
  });

  it('books nothing from an empty journal', async () => {
    const { gateway, writes } = fakeEconomic(BOOKING);
    const result = await gateway.callTool('book_journal', { journalNumber: 9, entryCount: 1 }, context);
    expect(result.isError).toBe(true);
    expect(writes()).toEqual([]);
  });

  it('books a journal larger than book_journal_entries allows, up to 100 entries', async () => {
    const entries = draftEntries(40);
    const { gateway, writes } = fakeEconomic(BOOKING, (method, path) =>
      method === 'GET' && path.endsWith('/draft-entries') ? Response.json({ items: entries }) : undefined,
    );
    const result = await gateway.callTool('book_journal', { journalNumber: 1, entryCount: 40, requireVoucher: false }, context);
    expect(result.isError, result.content[0]?.text).toBeUndefined();
    expect(writes()[0]?.body).toEqual({ entryNumbers: entries.map(entry => entry.entryNumber) });

    const tooMany = await gateway.callTool('book_journal', { journalNumber: 1, entryCount: 101 }, context);
    expect(tooMany.isError).toBe(true);
  });

  it('requires an attached document on every voucher unless requireVoucher is false', async () => {
    const { gateway, writes } = fakeEconomic(BOOKING, (method, path) =>
      method === 'GET' && path.endsWith('/AttachedDocuments/501') ? new Response('', { status: 404 }) : undefined,
    );
    const result = await gateway.callTool('book_journal', { journalNumber: 1, entryCount: 2 }, context);
    expect(result.isError).toBe(true);
    expect(writes()).toEqual([]);
  });

  it('is a booking tool: refused without allowBooking, before any request', async () => {
    const { gateway, requests } = fakeEconomic(WRITES);
    const result = await gateway.callTool('book_journal', { journalNumber: 1, entryCount: 2 }, context);
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toMatch(/booking disabled/);
    expect(requests).toEqual([]);
  });

  it('resolves the journal number and the number of entries for the log', () => {
    expect(resolveEconomicChange('book_journal', { journalNumber: 1, entryCount: 2, requireVoucher: false })).toEqual({
      ok: true,
      change: { tool: 'book_journal', action: 'book', record: 'journal', booking: true, values: { journalNumber: 1, entryCount: 2 } },
    });
  });

  it('never sends the whole-journal booking path', () => {
    const operations = economicToolCatalog.flatMap(tool => tool.upstream.map(operation => `${operation.method} ${operation.path}`));
    expect(operations.filter(operation => /\/(book|bookWithDateInterval)$/i.test(operation))).toEqual([]);
  });
});
