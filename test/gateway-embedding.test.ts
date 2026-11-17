import { afterEach, describe, expect, it, vi } from 'vitest';
import { registeredSecretCount } from '../src/errors.js';
import {
  createEconomicGateway,
  economicGatewayTools,
  economicServiceCatalog,
  economicToolCatalog,
  resolveEconomicReadTarget,
  type GatewayJsonObject,
} from '../src/gateway.js';

const NARROW_READ_TOOLS = [
  'search_entities',
  'customer_overview',
  'supplier_overview',
  'product_overview',
  'report_data',
  'invoice_overview',
  'project_overview',
  'accounting_entries',
];

const SERVICE_PATHS = new Map(economicServiceCatalog.services.map(service => [service.id, service.servicePath]));

function recordingGateway(response: () => Response = () => Response.json({ collection: [] })) {
  const requests: Request[] = [];
  const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    requests.push(new Request(input, init));
    return response();
  });
  const gateway = createEconomicGateway({
    appSecretToken: 'app-secret-for-tests',
    fetchImpl: fetchImpl as unknown as typeof fetch,
  });
  return { gateway, requests, fetchImpl };
}

const context = (agreementGrantToken: string) => ({ credentials: { agreementGrantToken } });

function catalogEntry(name: string) {
  const entry = economicToolCatalog.find(tool => tool.name === name);
  if (!entry) throw new Error(`no catalog entry for ${name}`);
  return entry;
}

const allResources = economicServiceCatalog.services.flatMap(service =>
  service.resources.map(resource => ({ serviceId: service.id, resource })),
);

describe('fixed read targets per tool', () => {
  it('lets every narrow tool read each of its listed targets, at that target', async () => {
    for (const name of NARROW_READ_TOOLS) {
      for (const target of catalogEntry(name).reads) {
        const { gateway, requests } = recordingGateway();
        const result = await gateway.callTool(name, { ...target, number: 7 }, context('grant-token-for-tests'));
        expect(result.isError, `${name} ${target.serviceId}:${target.resource}`).toBeUndefined();
        const url = new URL(requests[0]!.url);
        const servicePath = SERVICE_PATHS.get(target.serviceId);
        const expected = servicePath ? `/${servicePath}/${target.resource}/7` : `/${target.resource}/7`;
        expect(url.pathname).toBe(expected);
      }
    }
  });

  it('refuses every catalog resource outside a narrow tool’s list, before any request', async () => {
    for (const name of NARROW_READ_TOOLS) {
      const allowed = new Set(catalogEntry(name).reads.map(target => `${target.serviceId}:${target.resource}`));
      for (const target of allResources) {
        if (allowed.has(`${target.serviceId}:${target.resource}`)) continue;
        const { gateway, fetchImpl } = recordingGateway();
        const result = await gateway.callTool(name, { ...target }, context('grant-token-for-tests'));
        expect(result.isError, `${name} must not read ${target.serviceId}:${target.resource}`).toBe(true);
        expect(fetchImpl).not.toHaveBeenCalled();
        expect(resolveEconomicReadTarget(name, { ...target }).ok).toBe(false);
      }
    }
  });

  it('refuses booked entries through customer_overview, also in contract mode', async () => {
    const input = { serviceId: 'booked-entries', resource: 'booked-entries' };
    const { gateway, fetchImpl } = recordingGateway();
    const live = await gateway.callTool('customer_overview', input, context('grant-token-for-tests'));
    expect(live.isError).toBe(true);
    expect(live.content[0]?.text).toContain('customer_overview reads only');
    expect(fetchImpl).not.toHaveBeenCalled();

    const contract = await createEconomicGateway({ contractMode: true }).callTool('customer_overview', input);
    expect(contract.isError).toBe(true);
  });

  it('refuses a resource from another tool even when it is in the same service', async () => {
    const { gateway, fetchImpl } = recordingGateway();
    const result = await gateway.callTool(
      'invoice_overview',
      { serviceId: 'rest', resource: 'customers' },
      context('grant-token-for-tests'),
    );
    expect(result.isError).toBe(true);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('refuses fields a narrow tool does not have (selfUrl) and non-string targets', async () => {
    const { gateway, fetchImpl } = recordingGateway();
    const withSelfUrl = await gateway.callTool(
      'customer_overview',
      { selfUrl: 'https://restapi.e-conomic.com/accounts/1000' },
      context('grant-token-for-tests'),
    );
    expect(withSelfUrl.isError).toBe(true);
    expect(withSelfUrl.content[0]?.text).toContain('Unknown input field');
    const numericService = await gateway.callTool('customer_overview', { serviceId: 5 }, context('grant-token-for-tests'));
    expect(numericService.isError).toBe(true);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('declares the allowed values as enums in the input schema', () => {
    const tool = economicGatewayTools.find(candidate => candidate.name === 'supplier_overview')!;
    const properties = tool.inputSchema.properties as Record<string, GatewayJsonObject>;
    expect(properties.serviceId?.enum).toEqual(['rest', 'suppliers']);
    expect(properties.resource?.enum).toEqual(['suppliers', 'supplier-groups', 'Contacts', 'Groups']);
    expect(properties.selfUrl).toBeUndefined();
  });

  it('keeps get_entity as the one broad tool, limited to the catalog', async () => {
    const broad = economicToolCatalog.filter(tool => tool.broad).map(tool => tool.name);
    expect(broad).toEqual(['get_entity']);
    expect(catalogEntry('get_entity').reads).toEqual(allResources);
    expect(catalogEntry('get_entity').title).toMatch(/broad/i);

    const { gateway, requests } = recordingGateway(() => Response.json({ entryNumber: 1 }));
    const result = await gateway.callTool(
      'get_entity',
      { serviceId: 'booked-entries', resource: 'booked-entries', number: 1 },
      context('grant-token-for-tests'),
    );
    expect(result.isError).toBeUndefined();
    expect(new URL(requests[0]!.url).pathname).toBe('/bookedEntriesapi/v4.0.0/booked-entries/1');

    const self = await gateway.callTool('get_entity', { serviceId: 'rest', resource: 'self', number: 1 }, context('grant-token-for-tests'));
    expect(self.isError).toBe(true);
  });

  it('resolves the target of a get_entity self URL for logging', () => {
    expect(resolveEconomicReadTarget('get_entity', { selfUrl: 'https://restapi.e-conomic.com/invoices/booked/70001' })).toEqual({
      ok: true,
      target: {
        serviceId: 'rest',
        resource: 'invoices/booked',
        method: 'GET',
        pathTemplate: '/invoices/booked/{number}',
        pathParams: { number: '70001' },
      },
    });
    expect(resolveEconomicReadTarget('upsert_customer', {}).ok).toBe(false);
  });
});

describe('catalog export', () => {
  it('lists every tool once with its reads and writes, frozen', () => {
    expect(economicToolCatalog.map(tool => tool.name)).toEqual(economicGatewayTools.map(tool => tool.name));
    expect(Object.isFrozen(economicToolCatalog)).toBe(true);
    expect(Object.isFrozen(economicToolCatalog[0]!.reads)).toBe(true);
    expect(Object.isFrozen(economicServiceCatalog.endpoints)).toBe(true);
    expect(() => {
      (catalogEntry('customer_overview').reads as Array<{ serviceId: string; resource: string }>).push({ serviceId: 'booked-entries', resource: 'booked-entries' });
    }).toThrow();
    for (const tool of economicToolCatalog) {
      expect(tool.riskLevel === 'read' ? tool.writes : tool.reads.concat(tool.writes)).toBeDefined();
      if (tool.riskLevel === 'read') expect(tool.writes).toEqual([]);
      else expect(tool.writes.length).toBeGreaterThan(0);
    }
    expect(catalogEntry('customer_overview').defaultRead).toEqual({ serviceId: 'customers', resource: 'Customers' });
    expect(catalogEntry('get_entity').defaultRead).toBeUndefined();
  });

  it('keeps booked entries out of every narrow read tool except accounting_entries', () => {
    for (const name of NARROW_READ_TOOLS.filter(tool => tool !== 'accounting_entries')) {
      expect(catalogEntry(name).reads.some(target => target.serviceId === 'booked-entries')).toBe(false);
    }
  });

  it('marks endpoints read or write by method', () => {
    for (const endpoint of economicServiceCatalog.endpoints) {
      expect(endpoint.access).toBe(endpoint.method === 'GET' ? 'read' : 'write');
    }
    expect(economicServiceCatalog.endpoints.some(endpoint => endpoint.pathTemplate === '/booked-entries/match' && endpoint.access === 'write')).toBe(true);
  });
});

describe('call context and environment', () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
  });

  it('uses the credential passed with each call, and only that', async () => {
    const { gateway, requests } = recordingGateway();
    await gateway.callTool('customer_overview', {}, { ...context('first-company-token'), requestId: 'r1', caller: 'a' });
    await gateway.callTool('customer_overview', {}, context('second-company-token'));
    expect(requests.map(request => request.headers.get('X-AgreementGrantToken'))).toEqual([
      'first-company-token',
      'second-company-token',
    ]);
    expect(requests[0]?.headers.get('X-AppSecretToken')).toBe('app-secret-for-tests');
  });

  it('does not fall back to the options token when the call context carries an empty credential', async () => {
    const fetchImpl = vi.fn(async () => Response.json({}));
    const gateway = createEconomicGateway({
      appSecretToken: 'app-secret-for-tests',
      agreementGrantToken: 'single-tenant-token',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const result = await gateway.callTool('customer_overview', {}, { credentials: { agreementGrantToken: '' } });
    expect(result.isError).toBe(true);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('never reads ECONOMIC_* environment variables', async () => {
    process.env.ECONOMIC_APP_SECRET_TOKEN = 'env-app-secret-token';
    process.env.ECONOMIC_AGREEMENT_GRANT_TOKEN = 'env-agreement-grant-token';
    process.env.ECONOMIC_BASE_URL_REST = 'http://localhost:1';
    process.env.ECONOMIC_BASE_URL_OPENAPI = 'http://localhost:2';
    process.env.ECONOMIC_TIMEOUT_MS = 'not-a-number';
    process.env.ECONOMIC_ENABLE_WRITES = 'true';

    expect(() => createEconomicGateway({})).toThrow(/appSecretToken is required/);

    const { gateway, requests, fetchImpl } = recordingGateway();
    const missing = await gateway.callTool('customer_overview', {});
    expect(missing.isError).toBe(true);
    expect(missing.content[0]?.text).toContain('Missing e-conomic agreement grant token');
    expect(fetchImpl).not.toHaveBeenCalled();

    await gateway.callTool('search_entities', {}, context('grant-token-for-tests'));
    expect(new URL(requests[0]!.url).origin).toBe('https://restapi.e-conomic.com');
    expect(requests[0]?.headers.get('X-AgreementGrantToken')).toBe('grant-token-for-tests');

    const write = await gateway.callTool('upsert_customer', { customerNumber: 1, name: 'X' }, context('grant-token-for-tests'));
    expect(write.isError).toBe(true);
    expect(write.content[0]?.text).toContain('writes disabled');
    expect(requests.some(request => request.method !== 'GET')).toBe(false);
  });

  it('keeps per-call tokens out of process-wide state and redacts them from errors', async () => {
    const before = registeredSecretCount();
    const { gateway } = recordingGateway(
      () => new Response('denied for per-call-token-123456', { status: 403, headers: { 'content-type': 'text/plain' } }),
    );
    const result = await gateway.callTool('customer_overview', {}, context('per-call-token-123456'));
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('HTTP 403');
    expect(result.content[0]?.text).not.toContain('per-call-token-123456');
    expect(registeredSecretCount()).toBe(before);
  });
});

describe('defaults, answer text and company context', () => {
  it('reads the REST lists behind the search_entities and supplier_overview defaults', async () => {
    for (const [name, path] of [['search_entities', '/customers'], ['supplier_overview', '/suppliers']] as const) {
      const { gateway, requests } = recordingGateway();
      const result = await gateway.callTool(name, {}, context('grant-token-for-tests'));
      expect(result.isError, name).toBeUndefined();
      expect(new URL(requests[0]!.url).pathname).toBe(path);
    }
  });

  it('answers with a short summary text next to the structured content', async () => {
    const { gateway } = recordingGateway(() =>
      Response.json({ collection: [{ customerNumber: 1 }, { customerNumber: 2 }], pagination: { results: 10 } }),
    );
    const list = await gateway.callTool('search_entities', {}, context('grant-token-for-tests'));
    expect(list.content[0]?.text).toBe('search_entities: 2 of 10 records from rest:customers. More pages are available.');
    expect(list.structuredContent).toMatchObject({ collection: [{ customerNumber: 1 }, { customerNumber: 2 }] });

    const one = await gateway.callTool('customer_overview', { number: 1 }, context('grant-token-for-tests'));
    expect(one.content[0]?.text).toBe('customer_overview: one record from customers:Customers.');

    const contract = await createEconomicGateway({ contractMode: true }).callTool('invoice_overview', {});
    expect(contract.content[0]?.text).toBe('invoice_overview: 2 records from rest:invoices/booked.');
  });

  it('returns only the promised company context from /self', async () => {
    const self = {
      agreementNumber: 123456,
      agreementType: { agreementTypeNumber: 2, name: 'Plus' },
      bankInformation: { bankName: 'Some Bank', bankAccountNumber: '1234567890', bankGiroNumber: '42' },
      company: {
        name: 'Testfirma ApS',
        addressLine1: 'Gade 1',
        addressLine2: null,
        zip: '2000',
        city: 'By',
        country: 'Danmark',
        companyIdentificationNumber: '11223344',
        vatNumber: 'DK11223344',
        email: 'firma@example.test',
        phoneNumber: '12345678',
      },
      user: { name: 'Granting User', email: 'granting.user@example.test', loginId: 'granting-login' },
      userName: 'Granting User',
      application: { appPublicToken: 'public-app-token', name: 'App' },
      modules: [{ moduleNumber: 7, name: 'Projekt', self: 'https://restapi.e-conomic.com/modules/7' }],
      settings: { baseCurrency: 'DKK', internationalLedger: true, other: 'x' },
    };
    const { gateway, requests } = recordingGateway(() => Response.json(self));
    const result = await gateway.callTool('company_context', {}, context('grant-token-for-tests'));
    expect(new URL(requests[0]!.url).pathname).toBe('/self');
    expect(result.structuredContent).toEqual({
      agreementNumber: 123456,
      agreementType: 'Plus',
      company: {
        name: 'Testfirma ApS',
        addressLine1: 'Gade 1',
        addressLine2: null,
        zip: '2000',
        city: 'By',
        country: 'Danmark',
        companyIdentificationNumber: '11223344',
        vatNumber: 'DK11223344',
      },
      modules: [{ moduleNumber: 7, name: 'Projekt' }],
      settings: { baseCurrency: 'DKK', internationalLedger: true },
    });
    const text = JSON.stringify(result);
    for (const leaked of ['Some Bank', '1234567890', 'Granting User', 'granting.user@example.test', 'granting-login', 'public-app-token', 'firma@example.test']) {
      expect(text).not.toContain(leaked);
    }

    const contract = await createEconomicGateway({ contractMode: true }).callTool('company_context', {});
    expect(JSON.stringify(contract)).not.toMatch(/Demo Bank|user@example\.test|demo-public-token/);
  });
});
