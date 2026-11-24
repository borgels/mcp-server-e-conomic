// An agreement without an add-on module (#99): after e-conomic answers a request with an error, the gateway reads
// the agreement's modules (GET /self) and says plainly that the module is not enabled, marked with the module's id
// (`missingModule`), for the project, dimension and subscription tools and for the broad reads of their data.
import { describe, expect, it } from 'vitest';
import {
  createEconomicGateway,
  economicToolCatalog,
  type EconomicHostPolicy,
  type GatewayJsonObject,
} from '../src/gateway.js';

const context = { credentials: { agreementGrantToken: 'grant-token-for-tests' } };

// The modules of an agreement, as e-conomic's own demo agreement names and numbers them in /self.
const PROJECT = { moduleNumber: 4, name: 'Projektstyring' };
const DIMENSION = { moduleNumber: 14, name: 'Dimension (afdeling/kvantum)' };
const SUBSCRIPTION = { moduleNumber: 74, name: 'Subscription and Direct Debit' };
const OTHER = { moduleNumber: 3, name: 'Indscanning' };

const PROJECT_OFF ='The Project module is not enabled for this agreement in e-conomic. It must be turned on in e-conomic before this can be used.';

/**
 * A stand-in for e-conomic: /self lists `modules` (or answers `self` itself), everything else answers `status`.
 * Records the paths asked for.
 */
function agreement(
  modules: unknown,
  status = 403,
  policy: EconomicHostPolicy = { enableWrites: true, allowBooking: true },
  self?: () => Response,
) {
  const paths: string[] = [];
  const gateway = createEconomicGateway({
    appSecretToken: 'app-secret-for-tests',
    policy,
    fetchImpl: (async (input: string | URL | Request, init?: RequestInit) => {
      const path = new URL(new Request(input, init).url).pathname;
      paths.push(path);
      if (path === '/self') return self ? self() : Response.json({ agreementNumber: 1, modules });
      return new Response('{"message":"Forbidden"}', { status, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch,
  });
  return { gateway, paths };
}

describe('an agreement without the Project module', () => {
  it('says so on project_overview, with the module’s id and e-conomic’s status', async () => {
    const { gateway, paths } = agreement([OTHER, DIMENSION, SUBSCRIPTION]);
    const result = await gateway.callTool('project_overview', {}, context);
    expect(result).toEqual({
      isError: true,
      content: [{ type: 'text', text: PROJECT_OFF }],
      failure: { httpStatus: 403 },
      missingModule: 'project',
    });
    expect(paths).toEqual(['/projectsapi/v1.1.1/Projects/paged', '/self']);
  });

  it('says so for every resource project_overview reads but the employees, whatever the error', async () => {
    const resources = [
      ...new Set(
        economicToolCatalog
          .find(tool => tool.name === 'project_overview')!
          .upstream.filter(operation => operation.serviceId === 'projects')
          .map(operation => operation.resource),
      ),
    ].filter(resource => !['Employees', 'EmployeeGroups'].includes(resource));
    expect(resources.length).toBeGreaterThan(10);
    for (const resource of resources) {
      for (const status of [400, 403, 404, 500]) {
        const { gateway } = agreement([OTHER], status);
        const result = await gateway.callTool('project_overview', { resource }, context);
        expect(result.missingModule, `${resource} ${status}`).toBe('project');
        expect(result.failure, `${resource} ${status}`).toEqual({ httpStatus: status });
      }
    }
  });

  it('asks nothing about modules when e-conomic is throttling or gave up waiting (429, 408)', async () => {
    const calls: Array<[string, GatewayJsonObject]> = [
      ['project_overview', {}],
      ['dimension_overview', {}],
      ['subscription_overview', {}],
      ['upsert_project', { name: 'Tagrenovering', projectGroupNumber: 1 }],
    ];
    for (const status of [408, 429]) {
      for (const [tool, input] of calls) {
        const { gateway, paths } = agreement([], status);
        const result = await gateway.callTool(tool, input, context);
        expect(result.isError, `${tool} ${status}`).toBe(true);
        expect(result.missingModule, `${tool} ${status}`).toBeUndefined();
        expect(result.failure, `${tool} ${status}`).toEqual({ httpStatus: status });
        expect(paths, `${tool} ${status}`).not.toContain('/self');
      }
    }
  });

  it('says so on every project write tool', async () => {
    const calls: Array<[string, GatewayJsonObject]> = [
      ['upsert_project', { name: 'Tagrenovering', projectGroupNumber: 1 }],
      ['upsert_project', { projectNumber: 7, name: 'Tagrenovering' }],
      ['create_time_entry', { projectNumber: 1, activityNumber: 2, employeeNumber: 3, date: '2026-03-02', hours: 7.5 }],
      ['update_time_entry', { timeEntryNumber: 5, hours: 6 }],
      ['create_mileage_entry', { projectNumber: 1, employeeNumber: 3, date: '2026-03-02', distance: 42.5 }],
      ['approve_time_entries', { timeEntryNumbers: [5] }],
      ['delete_time_entry', { timeEntryNumber: 5 }],
    ];
    for (const [tool, input] of calls) {
      const { gateway, paths } = agreement([OTHER]);
      const result = await gateway.callTool(tool, input, context);
      expect(result, `${tool} ${JSON.stringify(input)}`).toMatchObject({
        isError: true,
        content: [{ text: PROJECT_OFF }],
        failure: { httpStatus: 403 },
        missingModule: 'project',
      });
      expect(paths.at(-1), tool).toBe('/self');
    }
  });

  it('says so where a missing record is otherwise answered in our own words (404)', async () => {
    const off = agreement([OTHER], 404);
    expect(await off.gateway.callTool('delete_time_entry', { timeEntryNumber: 5 }, context)).toMatchObject({
      isError: true,
      content: [{ text: PROJECT_OFF }],
      failure: { httpStatus: 404 },
      missingModule: 'project',
    });

    const on = agreement([PROJECT], 404);
    const kept = await on.gateway.callTool('delete_time_entry', { timeEntryNumber: 5 }, context);
    expect(kept.content[0]!.text).toContain('Time entry 5 does not exist');
    expect(kept.failure).toEqual({ httpStatus: 404 });
    expect(kept.missingModule).toBeUndefined();
  });

  it('says so when search_entities and get_entity read projects, and not when they read anything else', async () => {
    const projects: Array<[string, GatewayJsonObject]> = [
      ['search_entities', { serviceId: 'projects', resource: 'Projects' }],
      ['get_entity', { serviceId: 'projects', resource: 'Projects', number: 1 }],
      ['get_entity', { selfUrl: 'https://apis.e-conomic.com/projectsapi/v1.1.1/TimeEntries/5' }],
    ];
    for (const [tool, input] of projects) {
      const { gateway } = agreement([OTHER]);
      expect((await gateway.callTool(tool, input, context)).missingModule, `${tool} ${JSON.stringify(input)}`).toBe('project');
    }

    const others: Array<[string, GatewayJsonObject]> = [
      ['search_entities', {}],
      ['get_entity', { serviceId: 'rest', resource: 'customers', number: 1 }],
      ['customer_overview', {}],
    ];
    for (const [tool, input] of others) {
      const { gateway, paths } = agreement([OTHER]);
      const result = await gateway.callTool(tool, input, context);
      expect(result.isError, tool).toBe(true);
      expect(result.missingModule, tool).toBeUndefined();
      expect(result.content[0]!.text, tool).toContain('HTTP 403');
      // Nothing about the agreement's modules is asked for a read that needs none.
      expect(paths, tool).not.toContain('/self');
    }
  });

  it('asks about the module for employees only after a refusal (403): they are also there without it', async () => {
    const refusedRead = agreement([OTHER], 403);
    expect((await refusedRead.gateway.callTool('project_overview', { resource: 'Employees' }, context)).missingModule).toBe('project');
    const refusedWrite = agreement([OTHER], 403);
    expect((await refusedWrite.gateway.callTool('upsert_employee', { name: 'Ny kollega' }, context)).missingModule).toBe('project');

    for (const status of [400, 404, 500]) {
      for (const resource of ['Employees', 'EmployeeGroups']) {
        const { gateway, paths } = agreement([OTHER], status);
        const result = await gateway.callTool('project_overview', { resource, query: { filter: 'name$like:x' } }, context);
        expect(result.missingModule, `${resource} ${status}`).toBeUndefined();
        expect(result.content[0]!.text, `${resource} ${status}`).toContain(`HTTP ${status}`);
        expect(paths, `${resource} ${status}`).not.toContain('/self');
      }
    }
    const invalid = agreement([OTHER], 400);
    const result = await invalid.gateway.callTool('upsert_employee', { name: 'Ny kollega' }, context);
    expect(result.missingModule).toBeUndefined();
    expect(invalid.paths).not.toContain('/self');
    // An employee that is not there (404 on the read before the change) is answered as that, not as a module.
    const unknown = agreement([OTHER], 404);
    const missing = await unknown.gateway.callTool('upsert_employee', { employeeNumber: 9, name: 'Ny kollega' }, context);
    expect(missing.isError).toBe(true);
    expect(missing.missingModule).toBeUndefined();
    expect(unknown.paths).not.toContain('/self');
  });

  it('says nothing about modules when the agreement lists none and the call needs none', async () => {
    const { gateway, paths } = agreement([]);
    const result = await gateway.callTool('customer_overview', {}, context);
    expect(result.missingModule).toBeUndefined();
    expect(paths).not.toContain('/self');
    // An empty list is a list: the module is not there.
    expect((await agreement([]).gateway.callTool('project_overview', {}, context)).missingModule).toBe('project');
  });
});

describe('an agreement with the Project module', () => {
  it('keeps e-conomic’s own error, recognising the module by its number or by its name', async () => {
    const listed = [
      [PROJECT],
      // The number alone, with a name in another language.
      [{ moduleNumber: 4, name: 'Prosjektstyring' }],
      // The name alone.
      [{ name: 'Projektstyring' }],
      [{ name: 'Project' }],
    ];
    for (const modules of listed) {
      const { gateway, paths } = agreement(modules);
      const result = await gateway.callTool('project_overview', {}, context);
      expect(result.isError, JSON.stringify(modules)).toBe(true);
      expect(result.missingModule, JSON.stringify(modules)).toBeUndefined();
      expect(result.content[0]!.text, JSON.stringify(modules)).toContain('e-conomic API request failed with HTTP 403');
      expect(result.failure, JSON.stringify(modules)).toEqual({ httpStatus: 403 });
      expect(paths, JSON.stringify(modules)).toEqual(['/projectsapi/v1.1.1/Projects/paged', '/self']);
    }
  });

  it('answers as before when the read succeeds: the modules are never asked for', async () => {
    const paths: string[] = [];
    const gateway = createEconomicGateway({
      appSecretToken: 'app-secret-for-tests',
      fetchImpl: (async (input: string | URL | Request) => {
        paths.push(new URL(String(input)).pathname);
        return Response.json({ items: [] });
      }) as typeof fetch,
    });
    const result = await gateway.callTool('project_overview', {}, context);
    expect(result.isError).toBeUndefined();
    expect(result.missingModule).toBeUndefined();
    expect(paths).toEqual(['/projectsapi/v1.1.1/Projects/paged']);
  });

  it('asks nothing about modules after a change that went through', async () => {
    const paths: string[] = [];
    const gateway = createEconomicGateway({
      appSecretToken: 'app-secret-for-tests',
      policy: { enableWrites: true },
      fetchImpl: (async (input: string | URL | Request) => {
        paths.push(new URL(String(input)).pathname);
        return Response.json({ number: 12 }, { status: 201 });
      }) as typeof fetch,
    });
    const result = await gateway.callTool(
      'create_time_entry',
      { projectNumber: 1, activityNumber: 2, employeeNumber: 3, date: '2026-03-02', hours: 7.5 },
      context,
    );
    expect(result.isError).toBeUndefined();
    expect(result.missingModule).toBeUndefined();
    expect(paths).not.toContain('/self');
  });
});

describe('what a module answer never hides', () => {
  it('a refused access (401) goes on as e-conomic’s own error, and the modules are not asked for', async () => {
    const { gateway, paths } = agreement([OTHER], 401);
    const result = await gateway.callTool('project_overview', {}, context);
    expect(result.missingModule).toBeUndefined();
    expect(result.content[0]!.text).toContain('HTTP 401');
    expect(result.failure).toEqual({ httpStatus: 401 });
    expect(paths).toEqual(['/projectsapi/v1.1.1/Projects/paged']);

    // The same for a change.
    const write = agreement([OTHER], 401);
    const refused = await write.gateway.callTool('upsert_project', { name: 'Tagrenovering', projectGroupNumber: 1 }, context);
    expect(refused.isError).toBe(true);
    expect(refused.missingModule).toBeUndefined();
    expect(refused.failure).toEqual({ httpStatus: 401 });
    expect(write.paths).not.toContain('/self');
  });

  it('e-conomic’s own error stands when the modules cannot be read or are not a list', async () => {
    const answers = [
      () => new Response('{}', { status: 500 }),
      () => new Response('{}', { status: 401 }),
      () => Response.json({ agreementNumber: 1 }),
      () => Response.json({ modules: 'none' }),
      () => new Response('not json', { status: 200 }),
    ];
    for (const self of answers) {
      const { gateway } = agreement([], 403, { enableWrites: true }, self);
      const result = await gateway.callTool('project_overview', {}, context);
      expect(result.missingModule).toBeUndefined();
      expect(result.content[0]!.text).toContain('e-conomic API request failed with HTTP 403');
    }
  });

  it('a request that never got an answer says nothing about modules', async () => {
    const paths: string[] = [];
    const gateway = createEconomicGateway({
      appSecretToken: 'app-secret-for-tests',
      fetchImpl: (async (input: string | URL | Request) => {
        paths.push(new URL(String(input)).pathname);
        throw new TypeError('fetch failed');
      }) as typeof fetch,
    });
    const result = await gateway.callTool('project_overview', {}, context);
    expect(result.isError).toBe(true);
    expect(result.missingModule).toBeUndefined();
    expect(result.failure).toBeUndefined();
    expect(paths).not.toContain('/self');
  });

  it('an input the gateway refuses itself is answered before anything is sent', async () => {
    const { gateway, paths } = agreement([OTHER]);
    const result = await gateway.callTool('project_overview', { resource: 'Customers' }, context);
    expect(result.isError).toBe(true);
    expect(result.missingModule).toBeUndefined();
    expect(paths).toEqual([]);
  });
});

describe('the dimension and subscription modules', () => {
  it('are marked the same way, and recognised by number or by name', async () => {
    const calls: Array<[string, GatewayJsonObject, string]> = [
      ['dimension_overview', {}, 'dimension'],
      ['get_entity', { serviceId: 'dimensions', resource: 'dimensions', number: 1 }, 'dimension'],
      // The classic REST departments are the first dimension.
      ['get_entity', { serviceId: 'rest', resource: 'departments', number: 1 }, 'dimension'],
      ['get_entity', { serviceId: 'rest', resource: 'departmental-distributions', number: 1 }, 'dimension'],
      ['set_entry_dimensions', { target: 'draftEntry', journalNumber: 3, entryNumber: 27, dimensionNumber: 1, dimensionKey: 2 }, 'dimension'],
      ['subscription_overview', {}, 'subscription'],
      ['get_entity', { serviceId: 'subscriptions', resource: 'Subscribers', number: 1 }, 'subscription'],
      ['add_subscriber', { subscriptionNumber: 1, customerNumber: 2, startDate: '2026-01-01', endDate: '2026-01-31' }, 'subscription'],
      ['end_subscriber', { subscriberNumber: 3, expiryDate: '2026-06-30' }, 'subscription'],
    ];
    for (const [tool, input, module] of calls) {
      const off = agreement([PROJECT, OTHER]);
      const result = await off.gateway.callTool(tool, input, context);
      expect(result.missingModule, `${tool} ${JSON.stringify(input)}`).toBe(module);
      expect(result.content[0]!.text, tool).toMatch(/^The (Dimension|Subscription) module is not enabled for this agreement in e-conomic\./);

      // The module on: by number and name as e-conomic gives them, by the number alone (a name in another language),
      // and by the name alone.
      const listings = [
        [PROJECT, DIMENSION, SUBSCRIPTION],
        [{ moduleNumber: 14, name: 'Ulottuvuus' }, { moduleNumber: 74, name: 'Tilaus' }],
        [{ name: DIMENSION.name }, { name: SUBSCRIPTION.name }],
      ];
      for (const modules of listings) {
        const on = agreement(modules);
        const kept = await on.gateway.callTool(tool, input, context);
        expect(kept.isError, tool).toBe(true);
        expect(kept.missingModule, `${tool} with ${JSON.stringify(modules)}`).toBeUndefined();
      }
      // Another module's number or name is not this one.
      const wrong = module === 'dimension' ? [{ moduleNumber: 74, name: 'Tilaus' }] : [{ moduleNumber: 14, name: 'Ulottuvuus' }];
      expect((await agreement(wrong).gateway.callTool(tool, input, context)).missingModule, `${tool} with the other module`).toBe(module);
    }
  });
});

describe('the catalog', () => {
  it('names the module of every tool that belongs to one, and no other tool', () => {
    const modules = Object.fromEntries(economicToolCatalog.filter(tool => tool.module).map(tool => [tool.name, tool.module]));
    expect(modules).toEqual({
      project_overview: 'project',
      upsert_project: 'project',
      create_time_entry: 'project',
      update_time_entry: 'project',
      create_mileage_entry: 'project',
      approve_time_entries: 'project',
      delete_time_entry: 'project',
      dimension_overview: 'dimension',
      set_entry_dimensions: 'dimension',
      subscription_overview: 'subscription',
      add_subscriber: 'subscription',
      end_subscriber: 'subscription',
    });
    // Employees are also there without the Project module, so upsert_employee is not a tool of the module in the
    // catalog, although a refusal (403) of it is marked.
    expect(economicToolCatalog.find(tool => tool.name === 'upsert_employee')!.module).toBeUndefined();
  });

  it('declares the read of the agreement’s modules for every tool that may make it, once', () => {
    const self = (name: string) =>
      economicToolCatalog.find(tool => tool.name === name)!.upstream.filter(operation => operation.path === '/self');
    for (const tool of economicToolCatalog) {
      const expected =
        tool.module !== undefined ||
        ['search_entities', 'get_entity', 'check_connection', 'company_context', 'upsert_employee'].includes(tool.name);
      expect(self(tool.name), tool.name).toHaveLength(expected ? 1 : 0);
    }
  });
});
