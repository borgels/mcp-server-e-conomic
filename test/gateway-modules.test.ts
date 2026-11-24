// An agreement without an add-on module (#99, #101): after e-conomic refuses a request (HTTP 403), the gateway reads
// the agreement (GET /self) and says plainly that the module is not enabled, marked with the module's id
// (`missingModule`), for the project, dimension and subscription tools and for the broad reads of their data. Only
// after a 403, and only when the same answer shows that the app's roles are not the reason: an outage, a record that
// does not exist, a refused access and a missing app role always go on as e-conomic's own error.
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

const PROJECT_OFF = 'The Project module is not enabled for this agreement in e-conomic. It must be turned on in e-conomic before this can be used.';

/** Every status e-conomic documents or a gateway in front of it may answer, other than a refusal (403). */
const OTHER_STATUSES = [400, 401, 404, 408, 409, 422, 429, 500, 502, 503, 504];

/** One call per module and kind (narrow read, broad read, change), with the module it needs. */
const MODULE_CALLS: Array<[string, GatewayJsonObject, 'project' | 'dimension' | 'subscription']> = [
  ['project_overview', {}, 'project'],
  ['get_entity', { serviceId: 'projects', resource: 'Projects', number: 1 }, 'project'],
  ['upsert_project', { name: 'Tagrenovering', projectGroupNumber: 1 }, 'project'],
  ['dimension_overview', {}, 'dimension'],
  ['get_entity', { serviceId: 'rest', resource: 'departments', number: 1 }, 'dimension'],
  ['set_entry_dimensions', { target: 'draftEntry', journalNumber: 3, entryNumber: 27, dimensionNumber: 1, dimensionKey: 2 }, 'dimension'],
  ['subscription_overview', {}, 'subscription'],
  ['get_entity', { serviceId: 'subscriptions', resource: 'Subscribers', number: 1 }, 'subscription'],
  ['add_subscriber', { subscriptionNumber: 1, customerNumber: 2, startDate: '2026-01-01', endDate: '2026-01-31' }, 'subscription'],
];

/**
 * A stand-in for e-conomic: /self gives the agreement's `modules` and the app's roles (or answers `self` itself),
 * everything else answers `status`. Records the paths asked for. The app has the role SuperUser unless `roles` says
 * otherwise, as e-conomic's demo agreement answers.
 */
function agreement(
  modules: unknown,
  status = 403,
  options: { policy?: EconomicHostPolicy; self?: () => Response; roles?: readonly string[]; application?: unknown } = {},
) {
  const paths: string[] = [];
  const application =
    'application' in options
      ? options.application
      : { appNumber: 1, requiredRoles: (options.roles ?? ['SuperUser']).map((name, index) => ({ roleNumber: index + 1, name })) };
  const gateway = createEconomicGateway({
    appSecretToken: 'app-secret-for-tests',
    policy: options.policy ?? { enableWrites: true, allowBooking: true },
    fetchImpl: (async (input: string | URL | Request, init?: RequestInit) => {
      const path = new URL(new Request(input, init).url).pathname;
      paths.push(path);
      if (path === '/self') return options.self ? options.self() : Response.json({ agreementNumber: 1, application, modules });
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

  it('says so for every resource project_overview reads, when e-conomic refuses (403)', async () => {
    const resources = [
      ...new Set(
        economicToolCatalog
          .find(tool => tool.name === 'project_overview')!
          .upstream.filter(operation => operation.serviceId === 'projects')
          .map(operation => operation.resource),
      ),
    ];
    expect(resources.length).toBeGreaterThan(12);
    for (const resource of resources) {
      const { gateway } = agreement([OTHER]);
      const result = await gateway.callTool('project_overview', { resource }, context);
      expect(result.missingModule, resource).toBe('project');
      expect(result.failure, resource).toEqual({ httpStatus: 403 });
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
      ['upsert_employee', { name: 'Ny kollega' }],
      ['upsert_employee', { employeeNumber: 9, name: 'Ny kollega' }],
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
      // No modules at all on the agreement: a read that needs none is still never answered as a missing module.
      const { gateway, paths } = agreement([]);
      const result = await gateway.callTool(tool, input, context);
      expect(result.isError, tool).toBe(true);
      expect(result.missingModule, tool).toBeUndefined();
      expect(result.content[0]!.text, tool).toContain('HTTP 403');
      // Nothing about the agreement is asked for a read that needs no module.
      expect(paths, tool).not.toContain('/self');
    }
  });

  it('an empty list of modules is a list: the module is not there', async () => {
    expect((await agreement([]).gateway.callTool('project_overview', {}, context)).missingModule).toBe('project');
  });
});

describe('only a refusal (403) can mean that the module is missing', () => {
  it('an outage and every other status go on as e-conomic’s own error, and the agreement is not asked', async () => {
    for (const status of OTHER_STATUSES) {
      for (const [tool, input] of MODULE_CALLS) {
        // The agreement has no modules at all: were it asked, the answer would be the module's.
        const { gateway, paths } = agreement([], status);
        const result = await gateway.callTool(tool, input, context);
        const label = `${tool} ${JSON.stringify(input)} ${status}`;
        expect(result.isError, label).toBe(true);
        expect(result.missingModule, label).toBeUndefined();
        expect(result.content[0]!.text, label).not.toMatch(/module is not enabled/);
        expect(result.failure, label).toEqual({ httpStatus: status });
        expect(paths, label).not.toContain('/self');
      }
    }
  });

  it('a time entry that does not exist (404) is answered as that, with and without the module', async () => {
    for (const modules of [[OTHER], [PROJECT]]) {
      const { gateway, paths } = agreement(modules, 404);
      const result = await gateway.callTool('delete_time_entry', { timeEntryNumber: 5 }, context);
      expect(result.content[0]!.text).toContain('Time entry 5 does not exist');
      expect(result.failure).toEqual({ httpStatus: 404 });
      expect(result.missingModule).toBeUndefined();
      expect(paths).not.toContain('/self');
    }
  });

  it('a refused access (401) goes on as e-conomic’s own error, for a read and for a change', async () => {
    const { gateway, paths } = agreement([OTHER], 401);
    const result = await gateway.callTool('project_overview', {}, context);
    expect(result.missingModule).toBeUndefined();
    expect(result.content[0]!.text).toContain('HTTP 401');
    expect(result.failure).toEqual({ httpStatus: 401 });
    expect(paths).toEqual(['/projectsapi/v1.1.1/Projects/paged']);

    const write = agreement([OTHER], 401);
    const refused = await write.gateway.callTool('upsert_project', { name: 'Tagrenovering', projectGroupNumber: 1 }, context);
    expect(refused.isError).toBe(true);
    expect(refused.missingModule).toBeUndefined();
    expect(refused.failure).toEqual({ httpStatus: 401 });
    expect(write.paths).not.toContain('/self');
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

describe('a refusal that the app’s roles explain', () => {
  // e-conomic: a 403 "depends on the roles asked for when the grant was issued". The roles per resource are the ones
  // e-conomic's documentation names.
  it('stays e-conomic’s own error when the roles do not reach the resource, whatever the agreement has', async () => {
    const lacking: Record<string, readonly string[]> = {
      project: ['Sales', 'Bookkeeping'],
      // The dimensions service names different roles per resource, so only SuperUser reaches all of it.
      dimension: ['Bookkeeping', 'Sales', 'ProjectEmployee'],
      subscription: ['Bookkeeping', 'ProjectEmployee'],
    };
    for (const [tool, input, module] of MODULE_CALLS) {
      const { gateway, paths } = agreement([], 403, { roles: lacking[module]! });
      const result = await gateway.callTool(tool, input, context);
      const label = `${tool} ${JSON.stringify(input)}`;
      expect(result.isError, label).toBe(true);
      expect(result.missingModule, label).toBeUndefined();
      expect(result.content[0]!.text, label).toContain('e-conomic API request failed with HTTP 403');
      expect(result.failure, label).toEqual({ httpStatus: 403 });
      // The agreement was asked: it is its answer that shows the roles.
      expect(paths.at(-1), label).toBe('/self');
    }
  });

  it('is the module’s when a role reaches the resource and the module is not there', async () => {
    const reaching: Array<[string, GatewayJsonObject, readonly string[], string]> = [
      ['project_overview', {}, ['ProjectEmployee'], 'project'],
      ['project_overview', {}, ['Sales', 'SuperUser'], 'project'],
      // The name is compared without regard to case and spaces.
      ['project_overview', {}, ['Project Employee'], 'project'],
      ['project_overview', {}, ['superuser'], 'project'],
      ['upsert_project', { name: 'Tagrenovering', projectGroupNumber: 1 }, ['ProjectEmployee'], 'project'],
      ['subscription_overview', {}, ['Sales'], 'subscription'],
      ['add_subscriber', { subscriptionNumber: 1, customerNumber: 2, startDate: '2026-01-01', endDate: '2026-01-31' }, ['Sales'], 'subscription'],
      ['dimension_overview', {}, ['SuperUser'], 'dimension'],
    ];
    for (const [tool, input, roles, module] of reaching) {
      const { gateway } = agreement([], 403, { roles });
      expect((await gateway.callTool(tool, input, context)).missingModule, `${tool} ${roles.join('+')}`).toBe(module);
    }
  });

  it('goes by the employees’ own roles for employees and employee groups (SuperUser or Sales)', async () => {
    const calls: Array<[string, GatewayJsonObject]> = [
      ['project_overview', { resource: 'Employees' }],
      ['project_overview', { resource: 'EmployeeGroups' }],
      ['upsert_employee', { name: 'Ny kollega' }],
    ];
    for (const [tool, input] of calls) {
      const sales = agreement([OTHER], 403, { roles: ['Sales'] });
      expect((await sales.gateway.callTool(tool, input, context)).missingModule, `${tool} Sales`).toBe('project');
      // The project role does not reach employees: the refusal is about the roles.
      const project = agreement([OTHER], 403, { roles: ['ProjectEmployee'] });
      const kept = await project.gateway.callTool(tool, input, context);
      expect(kept.missingModule, `${tool} ProjectEmployee`).toBeUndefined();
      expect(kept.failure, `${tool} ProjectEmployee`).toEqual({ httpStatus: 403 });
    }
  });

  it('stays e-conomic’s own error when the answer does not say which roles the app has', async () => {
    const applications: unknown[] = [
      undefined,
      null,
      {},
      { requiredRoles: 'SuperUser' },
      { requiredRoles: [] },
      { requiredRoles: [{ roleNumber: 2 }, 'SuperUser', null] },
    ];
    for (const application of applications) {
      const { gateway } = agreement([], 403, { application });
      const result = await gateway.callTool('project_overview', {}, context);
      expect(result.missingModule, JSON.stringify(application)).toBeUndefined();
      expect(result.content[0]!.text, JSON.stringify(application)).toContain('e-conomic API request failed with HTTP 403');
      expect(result.failure, JSON.stringify(application)).toEqual({ httpStatus: 403 });
    }
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

  it('answers as before when the read succeeds: the agreement is never asked', async () => {
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

  it('asks nothing about the agreement after a change that went through', async () => {
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

describe('when the agreement cannot be read', () => {
  it('e-conomic’s own error stands when /self fails or has no list of modules', async () => {
    const application = { requiredRoles: [{ roleNumber: 2, name: 'SuperUser' }] };
    const answers = [
      () => new Response('{}', { status: 500 }),
      () => new Response('{}', { status: 401 }),
      () => new Response('{}', { status: 403 }),
      () => Response.json({ agreementNumber: 1, application }),
      () => Response.json({ application, modules: 'none' }),
      () => Response.json({ application, modules: null }),
      () => new Response('not json', { status: 200 }),
    ];
    for (const self of answers) {
      const { gateway } = agreement([], 403, { self });
      const result = await gateway.callTool('project_overview', {}, context);
      expect(result.missingModule).toBeUndefined();
      expect(result.content[0]!.text).toContain('e-conomic API request failed with HTTP 403');
      expect(result.failure).toEqual({ httpStatus: 403 });
    }
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
      expect(result.failure, tool).toEqual({ httpStatus: 403 });
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

  it('declares the read of the agreement for every tool that may make it, once', () => {
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
