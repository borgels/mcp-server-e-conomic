// The fence behind a broad app role (SuperUser): fixed refusals before any
// request is sent, no generic call, no passthrough fields, the credential
// headers owned by the client, and tokens kept out of errors and answers (#73).
import { describe, expect, it, vi } from 'vitest';
import { EconomicClient, type HttpMethod } from '../src/economic/client.js';
import { SecretRedactor } from '../src/errors.js';
import {
  GATEWAY_FENCE,
  createEconomicGateway,
  economicGatewayTools,
  economicServiceCatalog,
  economicToolCatalog,
  fenceRule,
  type GatewayJsonValue,
} from '../src/gateway.js';

const APP_SECRET = 'fake-app-secret-aaaabbbb';
const GRANT = 'fake-grant-token-ccccdddd';

function fencedClient() {
  const fetchImpl = vi.fn(async () => Response.json({}));
  const client = new EconomicClient({
    appSecretToken: APP_SECRET,
    agreementGrantToken: GRANT,
    credentialEnv: {},
    redactor: new SecretRedactor(),
    fetchImpl: fetchImpl as unknown as typeof fetch,
    fence: true,
  });
  return { client, fetchImpl };
}

/** Paths that are never sent through the gateway: REST, or OpenAPI as `service/version` plus path. */
const FENCED: Array<{ method: HttpMethod; rest?: string; openApi?: [string, string] }> = [
  { method: 'PUT', rest: '/self/company/bankinformation' },
  { method: 'PUT', rest: '/self/user' },
  { method: 'PUT', rest: '/self' },
  { method: 'PATCH', rest: '/Self/Company' },
  { method: 'PUT', rest: '/%73elf/user' },
  { method: 'POST', openApi: ['webhooksapi/v1.0.0', '/webhooks'] },
  { method: 'PUT', openApi: ['webhooksapi/v1.0.0', '/webhooks/1'] },
  { method: 'DELETE', openApi: ['webhooksapi/v1.0.0', '/webhooks/1'] },
  { method: 'POST', rest: '/webhooks' },
  { method: 'POST', openApi: ['journalsapi/v15.0.0', '/journals/5/book'] },
  { method: 'POST', openApi: ['journalsapi/v15.0.0', '/journals/5/bookWithDateInterval'] },
  { method: 'POST', openApi: ['journalsapi/v15.0.0', '/entries/draft/5/book'] },
  { method: 'POST', rest: '/journals/5/book' },
  { method: 'DELETE', rest: '/journals/5' },
  { method: 'DELETE', openApi: ['journalsapi/v15.0.0', '/journals/5'] },
  { method: 'DELETE', openApi: ['documentsapi/v3.0.1', '/AttachedDocuments/deletebulk'] },
  { method: 'POST', openApi: ['documentsapi/v3.0.1', '/AttachedDocuments/deletebulk'] },
  { method: 'DELETE', openApi: ['journalsapi/v15.0.0', '/draft-entries/delete/5'] },
  { method: 'POST', rest: '/accounting-years' },
  { method: 'PUT', rest: '/accounting-years/2026' },
  { method: 'POST', openApi: ['accountingyearsapi/v1.0.0', '/AccountingYears'] },
  { method: 'DELETE', rest: '/invoices/booked/70001' },
  { method: 'DELETE', openApi: ['bookedEntriesapi/v4.0.0', '/booked-entries/1'] },
  { method: 'DELETE', rest: '/customers/1' },
  { method: 'POST', rest: '/accounts' },
  { method: 'PUT', rest: '/accounts/1000' },
  { method: 'PUT', rest: '/suppliers/1/bankAccount' },
  { method: 'POST', rest: '/users' },
  { method: 'PUT', rest: '/app-roles/1' },
  { method: 'PUT', rest: '/settings' },
];

describe('the fixed fence', () => {
  it('refuses every fenced path before anything is sent', async () => {
    for (const fenced of FENCED) {
      const { client, fetchImpl } = fencedClient();
      const call = fenced.rest
        ? client.rest(fenced.rest, { method: fenced.method, body: fenced.method === 'DELETE' ? undefined : {} })
        : client.openApi(fenced.openApi![0], fenced.openApi![1], { method: fenced.method, body: fenced.method === 'DELETE' ? undefined : {} });
      await expect(call, `${fenced.method} ${fenced.rest ?? fenced.openApi!.join('')}`).rejects.toThrow(/gateway fence/);
      expect(fetchImpl, `${fenced.method} ${fenced.rest ?? fenced.openApi!.join('')}`).not.toHaveBeenCalled();
    }
  });

  it('lets reads of the company record through, and every request a gateway tool declares except the chart of accounts', () => {
    expect(fenceRule('GET', '/self')).toBeUndefined();
    expect(fenceRule('GET', '/accounts/1000')).toBeUndefined();
    expect(fenceRule('GET', '/accounting-years')).toBeUndefined();
    for (const tool of economicToolCatalog) {
      for (const operation of tool.upstream) {
        const path = operation.path.replace(/\{[^}]+\}/g, '1');
        const rule = fenceRule(operation.method, path);
        if (tool.name === 'upsert_account' && operation.access === 'write') {
          expect(rule?.reason, `${tool.name} ${operation.method} ${path}`).toBe('the chart of accounts');
        } else {
          expect(rule, `${tool.name} ${operation.method} ${path}`).toBeUndefined();
        }
      }
    }
  });

  it('applies whatever the host policy, through the gateway', async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const request = new Request(input, init);
      if (request.method === 'GET') return new Response('', { status: 404 });
      return Response.json({});
    });
    const gateway = createEconomicGateway({
      appSecretToken: APP_SECRET,
      policy: { enableWrites: true, allowBooking: true },
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const result = await gateway.callTool('upsert_account', { accountNumber: 4010, name: 'Konto', accountType: 'status' }, { credentials: { agreementGrantToken: GRANT } });
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain('the chart of accounts');
    const writes = fetchImpl.mock.calls.filter(([input, init]) => new Request(input, init).method !== 'GET');
    expect(writes).toEqual([]);
  });

  it('is a frozen list', () => {
    expect(Object.isFrozen(GATEWAY_FENCE)).toBe(true);
    expect(GATEWAY_FENCE.length).toBeGreaterThan(0);
  });
});

describe('no generic call', () => {
  it('has no tool that takes a method, a path or a URL', () => {
    for (const tool of economicGatewayTools) {
      expect(tool.name, tool.name).not.toMatch(/call|endpoint|raw|request|http/i);
      const properties = Object.keys((tool.inputSchema.properties ?? {}) as Record<string, unknown>);
      for (const forbidden of ['method', 'path', 'url', 'pathTemplate', 'endpoint', 'headers', 'body']) {
        expect(properties, `${tool.name} takes ${forbidden}`).not.toContain(forbidden);
      }
    }
  });

  it('declares only catalog endpoints as upstream requests', () => {
    const services = new Map(economicServiceCatalog.services.map(service => [service.id, service]));
    const known = new Set(
      economicServiceCatalog.endpoints.map(endpoint => {
        const service = services.get(endpoint.serviceId)!;
        const path = service.surface === 'rest' ? endpoint.pathTemplate : `/${service.servicePath}${endpoint.pathTemplate}`;
        return `${endpoint.method} ${path}`;
      }),
    );
    // The company record is read by check_connection and company_context only.
    known.add('GET /self');
    for (const tool of economicToolCatalog) {
      for (const operation of tool.upstream) {
        expect(known.has(`${operation.method} ${operation.path}`), `${tool.name}: ${operation.method} ${operation.path}`).toBe(true);
      }
    }
  });
});

describe('no passthrough fields', () => {
  /** Every object in a schema that is not a read tool's query must be closed. */
  function openObjects(schema: unknown, path: string): string[] {
    if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return [];
    const node = schema as Record<string, unknown>;
    const found: string[] = [];
    if (node.type === 'object' && node.additionalProperties !== false) found.push(path);
    for (const [key, value] of Object.entries(node)) {
      if (key === 'properties' && value && typeof value === 'object') {
        for (const [name, nested] of Object.entries(value as Record<string, unknown>)) {
          found.push(...openObjects(nested, `${path}.${name}`));
        }
      } else if (key === 'items') {
        found.push(...openObjects(value, `${path}[]`));
      }
    }
    return found;
  }

  it('gives every write tool a closed input schema, with no additionalFields', () => {
    for (const tool of economicGatewayTools.filter(candidate => candidate.riskLevel !== 'read')) {
      expect(openObjects(tool.inputSchema, tool.name), tool.name).toEqual([]);
      expect(Object.keys((tool.inputSchema.properties ?? {}) as Record<string, unknown>)).not.toContain('additionalFields');
    }
    // Read tools may pass query parameters to a GET, and nothing else open.
    for (const tool of economicGatewayTools.filter(candidate => candidate.riskLevel === 'read')) {
      expect(openObjects(tool.inputSchema, tool.name).filter(path => !path.endsWith('.query')), tool.name).toEqual([]);
    }
  });

  it('refuses a field outside the schema before any request', async () => {
    const fetchImpl = vi.fn(async () => Response.json({}));
    const gateway = createEconomicGateway({
      appSecretToken: APP_SECRET,
      policy: { enableWrites: true },
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const inputs: Array<[string, Record<string, GatewayJsonValue>]> = [
      ['upsert_project', { projectNumber: 1, additionalFields: { anything: 1 } }],
      ['create_time_entry', { projectNumber: 1, activityNumber: 1, employeeNumber: 1, date: '2026-01-02', hours: 1, additionalFields: { employee: { employeeNumber: 9 } } }],
      ['upsert_supplier', { supplierNumber: 1, additionalFields: { barred: true } }],
      ['upsert_supplier', { supplierNumber: 1, salesPerson: { employeeNumber: 1 } }],
    ];
    for (const [tool, input] of inputs) {
      const result = await gateway.callTool(tool, input, { credentials: { agreementGrantToken: GRANT } });
      expect(result.isError, tool).toBe(true);
      expect(result.content[0]!.text).toMatch(/Unknown input field/);
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('credential headers', () => {
  it('cannot be replaced or doubled by headers given with a request', async () => {
    for (const name of ['X-AppSecretToken', 'X-AgreementGrantToken', 'x-appsecrettoken', 'X-AGREEMENTGRANTTOKEN']) {
      const { client, fetchImpl } = fencedClient();
      await expect(client.request({ path: '/customers', headers: { [name]: 'fake-other-token-eeee' } })).rejects.toThrow(/cannot be given/);
      expect(fetchImpl).not.toHaveBeenCalled();
    }
  });

  it('sends the client’s own tokens, and other headers as given', async () => {
    const { client, fetchImpl } = fencedClient();
    await client.request({ path: '/customers', headers: { 'X-Custom': 'yes' } });
    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    const headers = new Headers(init.headers);
    expect(headers.get('X-AppSecretToken')).toBe(APP_SECRET);
    expect(headers.get('X-AgreementGrantToken')).toBe(GRANT);
    expect(headers.get('X-Custom')).toBe('yes');
  });
});

describe('tokens never reach the caller', () => {
  const echoes = [
    `X-AppSecretToken: ${APP_SECRET}, X-AgreementGrantToken: ${GRANT}`,
    `{"headers":{"X-AppSecretToken":"${APP_SECRET}","X-AgreementGrantToken":"${GRANT}"}}`,
    `request ${encodeURIComponent(APP_SECRET)} ${encodeURIComponent(GRANT)}`,
    `appSecretToken=${APP_SECRET}&agreementGrantToken=${GRANT}`,
  ];

  function echoingGateway(response: (echo: string) => Response, echo: string) {
    return createEconomicGateway({
      appSecretToken: APP_SECRET,
      fetchImpl: (async () => response(echo)) as typeof fetch,
    });
  }

  function expectNoToken(value: unknown, label: string): void {
    const text = JSON.stringify(value);
    expect(text, label).not.toContain(APP_SECRET);
    expect(text, label).not.toContain(GRANT);
    expect(text, label).not.toContain(encodeURIComponent(APP_SECRET));
  }

  it('redacts both tokens from an error, when e-conomic repeats them', async () => {
    const forms: Array<(echo: string) => Response> = [
      echo => new Response(JSON.stringify({ message: echo, errors: [echo], logId: echo }), { status: 400, headers: { 'content-type': 'application/json' } }),
      echo => new Response(echo, { status: 500, headers: { 'content-type': 'text/plain' } }),
      echo => new Response(JSON.stringify({ error: echo }), { status: 401, headers: { 'content-type': 'application/json' } }),
    ];
    for (const echo of echoes) {
      for (const form of forms) {
        const gateway = echoingGateway(form, echo);
        const result = await gateway.callTool('customer_overview', {}, { credentials: { agreementGrantToken: GRANT } });
        expect(result.isError).toBe(true);
        expectNoToken(result, echo);
      }
    }
  });

  it('redacts both tokens from a successful answer, text and structured content', async () => {
    for (const echo of echoes) {
      const gateway = echoingGateway(value => Response.json({ collection: [{ name: value, [GRANT]: value }] }), echo);
      const result = await gateway.callTool('customer_overview', {}, { credentials: { agreementGrantToken: GRANT } });
      expect(result.isError, result.content[0]?.text).toBeUndefined();
      expectNoToken(result, echo);
      expect(result.content[0]!.text).toContain('[REDACTED]');
      // The text block still carries exactly the structured content, as valid JSON.
      const [, json] = result.content[0]!.text.split('\n\n');
      expect(JSON.parse(json!)).toEqual(result.structuredContent);
    }
  });

  it('redacts a token from an early refusal that repeats the input', async () => {
    const fetchImpl = vi.fn(async () => Response.json({}));
    const gateway = createEconomicGateway({ appSecretToken: APP_SECRET, policy: { enableWrites: true }, fetchImpl: fetchImpl as unknown as typeof fetch });
    const calls: Array<[string, Record<string, GatewayJsonValue>]> = [
      ['customer_overview', { [APP_SECRET]: 1 }],
      ['get_entity', { serviceId: GRANT }],
      ['upsert_supplier', { supplierNumber: 1, [GRANT]: 'x' }],
      [`tool-${APP_SECRET}`, {}],
    ];
    for (const [tool, input] of calls) {
      const result = await gateway.callTool(tool, input, { credentials: { agreementGrantToken: GRANT } });
      expect(result.isError, tool).toBe(true);
      expectNoToken(result, tool);
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('contract mode and tokens with reserved characters', () => {
  it('refuses a tool behind the fence in contract mode too', async () => {
    const contract = createEconomicGateway({ contractMode: true, policy: { enableWrites: true, allowBooking: true } });
    const result = await contract.callTool('upsert_account', { accountNumber: 4010, name: 'Konto', accountType: 'status' });
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain('gateway fence');
  });

  it('redacts a token with /, + and = also in its URL-encoded form', async () => {
    const grant = 'fake/grant+token=aaaabbbbcccc';
    const echo = `raw ${grant} encoded ${encodeURIComponent(grant)}`;
    const gateway = createEconomicGateway({
      appSecretToken: APP_SECRET,
      fetchImpl: (async () => new Response(JSON.stringify({ message: echo }), { status: 400, headers: { 'content-type': 'application/json' } })) as typeof fetch,
    });
    const result = await gateway.callTool('customer_overview', {}, { credentials: { agreementGrantToken: grant } });
    const text = JSON.stringify(result);
    expect(encodeURIComponent(grant)).not.toBe(grant);
    expect(text).not.toContain(grant);
    expect(text).not.toContain(encodeURIComponent(grant));
  });
});
