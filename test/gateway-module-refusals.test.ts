// Two properties of the answer for a missing add-on module (#101, #103) that no tool shows on its own today:
//
// - Mixed refusals. A call asks the agreement about a module only when every request e-conomic refused in it is
//   a resource of that module that the app's roles reach. Each tool stops at its first refused request, so a
//   second refusal is put into the client's record here (EconomicClient.refused), as a tool that went on after a
//   refusal would leave it.
// - Calls at the same time. One gateway serves many agreements and callers; the refused requests, the roles and
//   the modules of one call never decide the answer of another.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EconomicClient, type EconomicRefusedRequest } from '../src/economic/client.js';
import { createEconomicGateway, type GatewayJsonObject, type GatewayToolResult } from '../src/gateway.js';

const PROJECT = { moduleNumber: 4, name: 'Projektstyring' };
const DIMENSION = { moduleNumber: 14, name: 'Dimension (afdeling/kvantum)' };
const SUBSCRIPTION = { moduleNumber: 74, name: 'Subscription and Direct Debit' };
const OTHER = { moduleNumber: 3, name: 'Indscanning' };

const recorded = Object.getOwnPropertyDescriptor(EconomicClient.prototype, 'refused')!.get as (
  this: EconomicClient,
) => readonly EconomicRefusedRequest[];

/** Makes every client record `change(what it recorded itself)` as the requests e-conomic refused. */
function recordingRefusals(change: (own: readonly EconomicRefusedRequest[]) => readonly EconomicRefusedRequest[]): void {
  vi.spyOn(EconomicClient.prototype, 'refused', 'get').mockImplementation(function (this: EconomicClient) {
    return change(recorded.call(this));
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

/** An agreement with no modules that refuses everything but /self (403), for an app with `roles`. */
function refusing(roles: readonly string[]) {
  const paths: string[] = [];
  const gateway = createEconomicGateway({
    appSecretToken: 'app-secret-for-tests',
    policy: { enableWrites: true, allowBooking: true },
    fetchImpl: (async (input: string | URL | Request, init?: RequestInit) => {
      const path = new URL(new Request(input, init).url).pathname;
      paths.push(path);
      if (path === '/self') {
        const requiredRoles = roles.map((name, index) => ({ roleNumber: index + 1, name }));
        return Response.json({ agreementNumber: 1, application: { appNumber: 1, requiredRoles }, modules: [] });
      }
      return new Response('{"message":"Forbidden"}', { status: 403, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch,
  });
  const call = (tool: string, input: GatewayJsonObject = {}) =>
    gateway.callTool(tool, input, { credentials: { agreementGrantToken: 'grant-token-for-tests' } });
  return { call, paths };
}

function expectOwnError(result: GatewayToolResult, label: string): void {
  expect(result.isError, label).toBe(true);
  expect(result.missingModule, label).toBeUndefined();
  expect(result.content[0]!.text, label).toContain('e-conomic API request failed with HTTP 403');
  expect(result.failure, label).toEqual({ httpStatus: 403 });
}

const openApi = (path: string, method = 'GET'): EconomicRefusedRequest => ({ method, surface: 'openapi', path });

describe('more than one refused request in a call', () => {
  it('the record is the client’s own without a change: one refusal, and the module answer', async () => {
    const { call } = refusing(['SuperUser']);
    recordingRefusals(own => {
      expect(own).toEqual([openApi('/projectsapi/v1.1.1/Projects/paged')]);
      return own;
    });
    expect((await call('project_overview')).missingModule).toBe('project');
  });

  it('keeps e-conomic’s own error when one of them is not a resource of the module, and does not ask the agreement', async () => {
    const others: EconomicRefusedRequest[] = [
      // Outside every module.
      { method: 'GET', surface: 'rest', path: '/customers' },
      openApi('/customersapi/v3.1.0/Customers/paged'),
      // Another module.
      openApi('/subscriptionsapi/v6.0.3/Subscribers', 'POST'),
      openApi('/dimensionsapi/v5.3.1/dimensions/paged'),
      { method: 'GET', surface: 'rest', path: '/departments/3' },
      // The module's API, but a resource e-conomic documents no roles for.
      openApi('/projectsapi/v1.1.1/Unknown/paged'),
      openApi('/projectsapi/v1.1.1'),
      // A request whose API cannot be told.
      { method: 'GET', surface: undefined, path: '/projectsapi/v1.1.1/Projects/paged' },
    ];
    for (const other of others) {
      for (const place of ['before', 'after'] as const) {
        // SuperUser reaches everything and the agreement has no modules: only the mixed refusals hold the answer back.
        const { call, paths } = refusing(['SuperUser']);
        recordingRefusals(own => (place === 'before' ? [other, ...own] : [...own, other]));
        const label = `${JSON.stringify(other)} ${place}`;
        expectOwnError(await call('project_overview'), label);
        expect(paths, label).toEqual(['/projectsapi/v1.1.1/Projects/paged']);
      }
    }
  });

  it('keeps e-conomic’s own error when no refused request is on record', async () => {
    const { call, paths } = refusing(['SuperUser']);
    recordingRefusals(() => []);
    expectOwnError(await call('project_overview'), 'no record');
    expect(paths).toEqual(['/projectsapi/v1.1.1/Projects/paged']);
  });

  it('needs a role for each of them when all are resources of the module', async () => {
    const draftEntry = { target: 'draftEntry', journalNumber: 3, entryNumber: 27, dimensionNumber: 1, dimensionKey: 2 };
    const cases: Array<[string, GatewayJsonObject, EconomicRefusedRequest, readonly string[], string | undefined]> = [
      // Projects (SuperUser or ProjectEmployee) and time entries (the same).
      ['project_overview', {}, openApi('/projectsapi/v1.1.1/TimeEntries/5'), ['ProjectEmployee'], 'project'],
      // Projects and employees (SuperUser or Sales): the project role alone does not reach both.
      ['project_overview', {}, openApi('/projectsapi/v1.1.1/Employees/paged'), ['ProjectEmployee'], undefined],
      ['project_overview', {}, openApi('/projectsapi/v1.1.1/Employees/paged'), ['Sales'], undefined],
      ['project_overview', {}, openApi('/projectsapi/v1.1.1/Employees/paged'), ['ProjectEmployee', 'Sales'], 'project'],
      ['project_overview', {}, openApi('/projectsapi/v1.1.1/Employees/paged'), ['SuperUser'], 'project'],
      // A dimension on a draft entry (SuperUser or Bookkeeping) and on a sales line (SuperUser or Sales).
      ['set_entry_dimensions', draftEntry, openApi('/dimensionsapi/v5.3.1/dimension-data/sales-document-lines', 'POST'), ['Bookkeeping'], undefined],
      ['set_entry_dimensions', draftEntry, openApi('/dimensionsapi/v5.3.1/dimension-data/sales-document-lines', 'POST'), ['Sales'], undefined],
      ['set_entry_dimensions', draftEntry, openApi('/dimensionsapi/v5.3.1/dimension-data/sales-document-lines', 'POST'), ['Bookkeeping', 'Sales'], 'dimension'],
      ['set_entry_dimensions', draftEntry, openApi('/dimensionsapi/v5.3.1/dimension-data/sales-document-lines', 'POST'), ['SuperUser'], 'dimension'],
      // The dimensions themselves are open to every role, so only the entry's role counts.
      ['set_entry_dimensions', draftEntry, openApi('/dimensionsapi/v5.3.1/dimensions/1'), ['Bookkeeping'], 'dimension'],
      ['set_entry_dimensions', draftEntry, openApi('/dimensionsapi/v5.3.1/dimensions/1'), ['ProjectEmployee'], undefined],
    ];
    for (const [tool, input, other, roles, expected] of cases) {
      const { call, paths } = refusing(roles);
      recordingRefusals(own => [...own, other]);
      const result = await call(tool, input);
      const label = `${tool} and ${other.path} with ${roles.join('+')}`;
      // The agreement is asked: every refused request is a resource of the module.
      expect(paths.at(-1), label).toBe('/self');
      if (expected) {
        expect(result.missingModule, label).toBe(expected);
        expect(result.failure, label).toEqual({ httpStatus: 403 });
      } else {
        expectOwnError(result, label);
      }
    }
  });
});

describe('one gateway, many agreements and callers', () => {
  /** What e-conomic answers for each agreement, by its grant token: its modules, the app's roles and the status of everything but /self. */
  const AGREEMENTS: Record<string, { modules: unknown[]; roles: string[]; status: number }> = {
    'grant-without-modules': { modules: [OTHER], roles: ['SuperUser'], status: 403 },
    'grant-with-modules': { modules: [PROJECT, DIMENSION, SUBSCRIPTION], roles: ['SuperUser'], status: 403 },
    'grant-bookkeeping-app': { modules: [], roles: ['Bookkeeping'], status: 403 },
    'grant-sales-app': { modules: [DIMENSION], roles: ['Sales'], status: 403 },
    'grant-in-an-outage': { modules: [], roles: ['SuperUser'], status: 503 },
    'grant-that-answers': { modules: [], roles: ['SuperUser'], status: 200 },
  };
  /** The answer each agreement must get for each tool: a module's id, or the status of e-conomic's own error, or 'ok'. */
  const EXPECTED: Record<string, Record<string, string | number>> = {
    'grant-without-modules': { project_overview: 'project', dimension_overview: 'dimension', subscription_overview: 'subscription' },
    'grant-with-modules': { project_overview: 403, dimension_overview: 403, subscription_overview: 403 },
    // Bookkeeping reaches the dimensions, not projects or subscriptions.
    'grant-bookkeeping-app': { project_overview: 403, dimension_overview: 'dimension', subscription_overview: 403 },
    // Sales reaches subscriptions and the dimensions (which this agreement has), not projects.
    'grant-sales-app': { project_overview: 403, dimension_overview: 403, subscription_overview: 'subscription' },
    'grant-in-an-outage': { project_overview: 503, dimension_overview: 503, subscription_overview: 503 },
    'grant-that-answers': { project_overview: 'ok', dimension_overview: 'ok', subscription_overview: 'ok' },
  };
  const TOKENS = Object.keys(AGREEMENTS);
  const TOOLS = ['project_overview', 'dimension_overview', 'subscription_overview'];

  function sharedGateway() {
    const asked: Array<{ token: string; path: string }> = [];
    let count = 0;
    const gateway = createEconomicGateway({
      appSecretToken: 'app-secret-for-tests',
      fetchImpl: (async (input: string | URL | Request, init?: RequestInit) => {
        const request = new Request(input, init);
        const token = request.headers.get('X-AgreementGrantToken') ?? '';
        const path = new URL(request.url).pathname;
        asked.push({ token, path });
        // Answers come back in another order than the requests were sent in, so the calls overlap.
        count += 1;
        await new Promise(resolve => setTimeout(resolve, (count * 7) % 11));
        const agreement = AGREEMENTS[token]!;
        if (path === '/self') {
          const requiredRoles = agreement.roles.map((name, index) => ({ roleNumber: index + 1, name }));
          return Response.json({ agreementNumber: 1, application: { appNumber: 1, requiredRoles }, modules: agreement.modules });
        }
        if (agreement.status === 200) return Response.json({ items: [] });
        return new Response('{"message":"Refused"}', { status: agreement.status, headers: { 'content-type': 'application/json' } });
      }) as typeof fetch,
    });
    return { gateway, asked };
  }

  function expectAnswer(result: GatewayToolResult, token: string, tool: string, label: string): void {
    const expected = EXPECTED[token]![tool]!;
    if (expected === 'ok') {
      expect(result.isError, label).toBeUndefined();
      expect(result.missingModule, label).toBeUndefined();
    } else if (typeof expected === 'number') {
      expect(result.isError, label).toBe(true);
      expect(result.missingModule, label).toBeUndefined();
      expect(result.failure, label).toEqual({ httpStatus: expected });
      expect(result.content[0]!.text, label).toContain(`e-conomic API request failed with HTTP ${expected}`);
    } else {
      expect(result.missingModule, label).toBe(expected);
      expect(result.failure, label).toEqual({ httpStatus: 403 });
    }
  }

  it('each call at the same time goes by its own agreement', async () => {
    const { gateway, asked } = sharedGateway();
    const calls: Array<{ token: string; tool: string; caller: string }> = [];
    for (let index = 0; index < 90; index += 1) {
      // 5 and 3 share no factor with the 6 agreements and 3 tools taken this way: every pair comes up, in mixed order.
      calls.push({ token: TOKENS[(index * 5) % TOKENS.length]!, tool: TOOLS[(index + Math.floor(index / 6)) % TOOLS.length]!, caller: `caller-${index % 4}` });
    }
    expect(new Set(calls.map(call => `${call.token} ${call.tool}`)).size).toBe(TOKENS.length * TOOLS.length);
    const results = await Promise.all(
      calls.map(call => gateway.callTool(call.tool, {}, { caller: call.caller, credentials: { agreementGrantToken: call.token } })),
    );
    results.forEach((result, index) => {
      const call = calls[index]!;
      expectAnswer(result, call.token, call.tool, `#${index} ${call.token} ${call.tool} ${call.caller}`);
      // No answer carries a grant token, its own or another's.
      for (const token of TOKENS) expect(JSON.stringify(result), `#${index}`).not.toContain(token);
    });
    // The agreement is asked once per refused call, with that call's own grant, and never after another status.
    for (const token of TOKENS) {
      const refusedCalls = calls.filter(call => call.token === token && AGREEMENTS[token]!.status === 403).length;
      expect(asked.filter(request => request.token === token && request.path === '/self').length, token).toBe(refusedCalls);
    }
    expect(asked.every(request => Object.hasOwn(AGREEMENTS, request.token))).toBe(true);
  });

  it('a call does not inherit what was refused in the call before it', async () => {
    // Were the refused projects request of the first call still on record, the second would be a mixed refusal.
    const { gateway } = sharedGateway();
    const context = { caller: 'caller-0', credentials: { agreementGrantToken: 'grant-bookkeeping-app' } };
    for (let round = 0; round < 3; round += 1) {
      expectAnswer(await gateway.callTool('project_overview', {}, context), 'grant-bookkeeping-app', 'project_overview', `round ${round}`);
      expectAnswer(await gateway.callTool('dimension_overview', {}, context), 'grant-bookkeeping-app', 'dimension_overview', `round ${round}`);
      expectAnswer(
        await gateway.callTool('subscription_overview', {}, { caller: 'caller-1', credentials: { agreementGrantToken: 'grant-without-modules' } }),
        'grant-without-modules',
        'subscription_overview',
        `round ${round}`,
      );
    }
  });
});
