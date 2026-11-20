// Projects and time in ./gateway (#67): changing time, mileage, approval,
// and what an employee may register on.
import { describe, expect, it } from 'vitest';
import {
  createEconomicGateway,
  resolveEconomicChange,
  resolveEconomicReadTarget,
  type EconomicHostPolicy,
  type GatewayJsonObject,
} from '../src/gateway.js';

const context = { credentials: { agreementGrantToken: 'grant-token-for-tests' } };

function fakeEconomic(policy: EconomicHostPolicy, answer: (request: Request) => Response | undefined = () => undefined) {
  const requests: Array<{ method: string; path: string; query: string; body?: unknown }> = [];
  const gateway = createEconomicGateway({
    appSecretToken: 'app-secret-for-tests',
    policy,
    fetchImpl: (async (input: string | URL | Request, init?: RequestInit) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      const text = request.method === 'GET' ? '' : await request.clone().text();
      requests.push({ method: request.method, path: url.pathname, query: url.search, ...(text ? { body: JSON.parse(text) } : {}) });
      return answer(request) ?? Response.json({ ok: true });
    }) as typeof fetch,
  });
  return { gateway, requests };
}

const entry = {
  number: 5,
  projectNumber: 1,
  activityNumber: 2,
  employeeNumber: 3,
  date: '2026-03-02T00:00:00',
  text: 'Montage',
  numberOfHours: 8,
  isApproved: false,
  isReconciled: false,
  lastUpdated: '2026-03-02T10:00:00',
  objectVersion: 'v1',
};

describe('update_time_entry', () => {
  it('reads the entry, merges the change and sends it back with its objectVersion, without read-only fields', async () => {
    const { gateway, requests } = fakeEconomic({ enableWrites: true }, request =>
      request.method === 'GET' ? Response.json(entry) : undefined);
    const result = await gateway.callTool('update_time_entry', { timeEntryNumber: 5, hours: 7.5, description: 'Montage og test' }, context);
    expect(result.isError, result.content[0]?.text).toBeUndefined();
    expect(requests).toEqual([
      { method: 'GET', path: '/projectsapi/v1.1.1/TimeEntries/5', query: '' },
      {
        method: 'PUT',
        path: '/projectsapi/v1.1.1/TimeEntries',
        query: '',
        body: {
          number: 5,
          projectNumber: 1,
          activityNumber: 2,
          employeeNumber: 3,
          date: '2026-03-02T00:00:00',
          text: 'Montage og test',
          numberOfHours: 7.5,
          objectVersion: 'v1',
        },
      },
    ]);
  });

  it('refuses an approved entry, an unknown entry, and an empty change', async () => {
    const approved = fakeEconomic({ enableWrites: true }, () => Response.json({ ...entry, isApproved: true }));
    const result = await approved.gateway.callTool('update_time_entry', { timeEntryNumber: 5, hours: 1 }, context);
    expect(result).toMatchObject({ isError: true, content: [{ text: 'Time entry 5 is approved and can no longer be changed.' }] });
    expect(approved.requests.some(request => request.method === 'PUT')).toBe(false);

    const missing = fakeEconomic({ enableWrites: true }, () => new Response('{}', { status: 404 }));
    expect((await missing.gateway.callTool('update_time_entry', { timeEntryNumber: 9, hours: 1 }, context)).content[0]?.text)
      .toBe('Time entry 9 does not exist.');

    const empty = fakeEconomic({ enableWrites: true });
    expect((await empty.gateway.callTool('update_time_entry', { timeEntryNumber: 5 }, context)).isError).toBe(true);
    for (const input of [{ timeEntryNumber: 5, hours: 25 }, { timeEntryNumber: 5, date: '2. marts' }] as GatewayJsonObject[]) {
      expect((await empty.gateway.callTool('update_time_entry', input, context)).isError).toBe(true);
    }
    expect(empty.requests).toEqual([]);
  });
});

describe('create_mileage_entry', () => {
  it('posts a trip and logs no addresses', async () => {
    const { gateway, requests } = fakeEconomic({ enableWrites: true });
    const input = { projectNumber: 1, employeeNumber: 3, date: '2026-03-02', distance: 42.5, from: 'Lager', to: 'Kunde' };
    const result = await gateway.callTool('create_mileage_entry', input, context);
    expect(result.isError).toBeUndefined();
    expect(requests).toEqual([
      { method: 'POST', path: '/projectsapi/v1.1.1/Mileages', query: '', body: { projectNumber: 1, employeeNumber: 3, date: '2026-03-02', distance: 42.5, from: 'Lager', to: 'Kunde' } },
    ]);
    expect(resolveEconomicChange('create_mileage_entry', input)).toMatchObject({
      ok: true,
      change: { values: { projectNumber: 1, employeeNumber: 3, date: '2026-03-02', distance: 42.5 } },
    });
    const values = (resolveEconomicChange('create_mileage_entry', input) as { change: { values: object } }).change.values;
    expect(JSON.stringify(values)).not.toMatch(/Lager|Kunde/);
  });
});

describe('approve_time_entries', () => {
  it('is a booking tool: refused without allowBooking, before any request', async () => {
    const { gateway, requests } = fakeEconomic({ enableWrites: true });
    const result = await gateway.callTool('approve_time_entries', { timeEntryNumbers: [5] }, context);
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('booking disabled');
    expect(requests).toEqual([]);
    expect(gateway.tools.map(tool => tool.name)).not.toContain('approve_time_entries');
  });

  it('approves the listed entries when the host allows booking', async () => {
    const { gateway, requests } = fakeEconomic({ enableWrites: true, allowBooking: true });
    const result = await gateway.callTool('approve_time_entries', { timeEntryNumbers: [5, 6] }, context);
    expect(result.isError).toBeUndefined();
    expect(result.content[0]?.text.split('\n\n')[0]).toBe('Approved 2 time entries.');
    expect(requests).toEqual([{ method: 'POST', path: '/projectsapi/v1.1.1/TimeEntries/approve', query: '', body: { numbers: [5, 6] } }]);
    expect(resolveEconomicChange('approve_time_entries', { timeEntryNumbers: [5, 6] })).toMatchObject({
      ok: true,
      change: { action: 'book', record: 'time-entry', booking: true, values: { timeEntryNumbers: [5, 6] } },
    });
  });

  it('refuses duplicates and bad numbers', async () => {
    const { gateway, requests } = fakeEconomic({ enableWrites: true, allowBooking: true });
    for (const timeEntryNumbers of [[5, 5], [0], []]) {
      expect((await gateway.callTool('approve_time_entries', { timeEntryNumbers }, context)).isError).toBe(true);
    }
    expect(requests).toEqual([]);
  });
});

describe('project_overview', () => {
  it('reads mileage, prices, project activities and what an employee may register on', async () => {
    const { gateway, requests } = fakeEconomic({}, () => Response.json([]));
    for (const resource of ['Mileages', 'MileagePrices', 'TimeEntryPrices', 'project-activities']) {
      expect((await gateway.callTool('project_overview', { resource }, context)).isError, resource).toBeUndefined();
    }
    await gateway.callTool('project_overview', { resource: 'Activities/allowed', query: { employeeNumber: 3, projectNumber: 1 } }, context);
    await gateway.callTool('project_overview', { resource: 'Projects/allowed', query: { employeeNumber: 3 } }, context);
    expect(requests.map(request => `${request.path}${request.query}`)).toEqual([
      '/projectsapi/v1.1.1/Mileages/paged',
      '/projectsapi/v1.1.1/MileagePrices/paged',
      '/projectsapi/v1.1.1/TimeEntryPrices/paged',
      '/projectsapi/v1.1.1/project-activities/paged',
      '/projectsapi/v1.1.1/Activities/allowed?employeeNumber=3&projectNumber=1',
      '/projectsapi/v1.1.1/Projects/allowed?employeeNumber=3',
    ]);
    expect(resolveEconomicReadTarget('project_overview', { resource: 'Activities/allowed' })).toMatchObject({
      ok: true,
      target: { pathTemplate: '/Activities/allowed' },
    });
  });
});
