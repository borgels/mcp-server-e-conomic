import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { EconomicClient } from '../src/economic/client.js';
import { findEndpoint } from '../src/economic/catalog.js';
import { CAPABILITY_ROUTES } from '../src/economic/capabilities.js';
import { materializePath, resolveSelfUrl } from '../src/economic/endpoints.js';
import { prepareOperation, verifyPreparedOperation, type PreparedOperation } from '../src/economic/operations.js';
import { prepareBooking, revalidateBookingOperation } from '../src/economic/bookings.js';
import { assertSafePathParam } from '../src/economic/path-params.js';
import { registerEconomicTools } from '../src/tools/economic.js';
import { createEconomicGateway } from '../src/gateway.js';
import {
  assertAuthorized,
  assertSafeHttpStartup,
  HttpRequestError,
} from '../src/transports/http-helpers.js';

const originalEnv = { ...process.env };

afterEach(() => {
  process.env = { ...originalEnv };
});

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value)
      .filter(([, nested]) => nested !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, nested]) => `${JSON.stringify(key)}:${stableStringify(nested)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

/** An operation the server never prepared, hashed with a plain (unkeyed) digest. */
function unsignedOperation(fields: Omit<PreparedOperation, 'operationHash' | 'policyDecision' | 'dryRun' | 'preparedAt' | 'expiresAt'>): PreparedOperation {
  const now = Date.now();
  const base = {
    capability: fields.capability,
    serviceId: fields.serviceId,
    method: fields.method,
    pathTemplate: fields.pathTemplate,
    pathParams: fields.pathParams,
    query: fields.query,
    body: fields.body,
    reason: fields.reason,
  };
  return {
    ...base,
    dryRun: true,
    preparedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + 60_000).toISOString(),
    operationHash: createHash('sha256').update(stableStringify(base)).digest('hex'),
    policyDecision: { allowed: true, reason: 'caller supplied', policy: {} as never },
  };
}

const drafts = {
  cursor: null,
  items: [
    { entryNumber: 11, journalNumber: 3, voucherNumber: 901, amount: 1200.5, text: 'A' },
    { entryNumber: 12, journalNumber: 3, voucherNumber: 901, amount: -1200.5, text: 'B' },
    { entryNumber: 13, journalNumber: 3, voucherNumber: 901, amount: 10, text: 'C' },
    { entryNumber: 14, journalNumber: 3, voucherNumber: 901, amount: -10, text: 'D' },
  ],
};

function makeFetch() {
  return vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    if (url.includes('/draft-entries')) return Response.json(drafts);
    if (url.includes('/AttachedDocuments/901')) return Response.json({ voucherNumber: 901 });
    if (url.includes('/bookdraftentries') || url.includes('/booked-entries/match')) return Response.json({ ok: true });
    return new Response('not found', { status: 404 });
  });
}

function makeClient(fetchImpl = makeFetch()): EconomicClient {
  return new EconomicClient({
    appSecretToken: 'app',
    agreementGrantToken: 'grant',
    fetchImpl: fetchImpl as unknown as typeof fetch,
  });
}

function usePolicy(policy: object): void {
  const dir = mkdtempSync(join(tmpdir(), 'policy-'));
  const policyPath = join(dir, 'policy.json');
  writeFileSync(policyPath, JSON.stringify(policy));
  process.env.ECONOMIC_POLICY_PATH = policyPath;
}

async function connectTools(client: EconomicClient): Promise<Client> {
  const server = new McpServer({ name: 'test', version: '0.0.0' });
  registerEconomicTools(server, client);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const mcp = new Client({ name: 'test-client', version: '0.0.0' });
  await mcp.connect(clientTransport);
  return mcp;
}

function enableBooking(): void {
  process.env.ECONOMIC_ENABLE_WRITES = 'true';
  process.env.ECONOMIC_ENABLE_BOOKING = 'true';
}

describe('prepared operation signing', () => {
  it('rejects operations that were not signed by this server', () => {
    const forged = unsignedOperation({
      capability: 'economic_prepare_customer_change',
      serviceId: 'customers',
      method: 'POST',
      pathTemplate: '/Customers',
      body: { name: 'Acme' },
      reason: 'not prepared here',
    });
    expect(() => verifyPreparedOperation(forged)).toThrow('signature does not match');
  });

  it('rejects expired operations', () => {
    const operation = prepareOperation(
      {
        capability: 'economic_prepare_customer_change',
        serviceId: 'customers',
        method: 'POST',
        pathTemplate: '/Customers',
        body: { name: 'Acme' },
        reason: 'expiry test',
      },
      new Date(Date.now() - 16 * 60 * 1000),
    );
    expect(() => verifyPreparedOperation(operation)).toThrow('expired');
  });

  it('binds signatures to ECONOMIC_PREPARE_SECRET', () => {
    process.env.ECONOMIC_PREPARE_SECRET = 'first-secret-value-for-tests';
    const operation = prepareOperation({
      capability: 'economic_prepare_customer_change',
      serviceId: 'customers',
      method: 'POST',
      pathTemplate: '/Customers',
      body: { name: 'Acme' },
      reason: 'secret test',
    });
    expect(() => verifyPreparedOperation(operation)).not.toThrow();
    process.env.ECONOMIC_PREPARE_SECRET = 'second-secret-value-for-tests';
    expect(() => verifyPreparedOperation(operation)).toThrow('signature does not match');
  });

  it('rejects a mismatched confirmOperationHash', () => {
    const operation = prepareOperation({
      capability: 'economic_prepare_customer_change',
      serviceId: 'customers',
      method: 'POST',
      pathTemplate: '/Customers',
      body: { name: 'Acme' },
      reason: 'confirm test',
    });
    expect(() => verifyPreparedOperation(operation, { confirmOperationHash: 'x'.repeat(64) })).toThrow(
      'confirmOperationHash',
    );
  });
});

describe('economic_commit_booking', () => {
  it('refuses operations that were not prepared by the server and never calls the booking endpoint', async () => {
    enableBooking();
    usePolicy({ maxAmount: 1000 });
    const fetchImpl = makeFetch();
    const mcp = await connectTools(makeClient(fetchImpl));

    const forged = unsignedOperation({
      capability: 'economic_prepare_booking',
      serviceId: 'journals',
      method: 'POST',
      pathTemplate: '/journals/{journalNumber}/bookdraftentries',
      pathParams: { journalNumber: 3 },
      body: { entryNumbers: [11, 12] },
      reason: 'not prepared by the server',
    });

    const result = await mcp.callTool({
      name: 'economic_commit_booking',
      arguments: { operation: forged, idempotencyKey: 'idem-key-1', confirmOperationHash: forged.operationHash },
    });

    expect(result.isError).toBe(true);
    expect(fetchImpl.mock.calls.map(([url]) => String(url)).some(url => url.includes('bookdraftentries'))).toBe(false);
  });

  it('commits a server-prepared booking after re-running the guardrails', async () => {
    enableBooking();
    const fetchImpl = makeFetch();
    const client = makeClient(fetchImpl);
    const mcp = await connectTools(client);
    const prepared = await prepareBooking(client, { journalNumber: 3, entryNumbers: [13, 14], reason: 'small booking test' });
    fetchImpl.mockClear();

    const result = await mcp.callTool({
      name: 'economic_commit_booking',
      arguments: {
        operation: JSON.parse(JSON.stringify(prepared.operation)),
        idempotencyKey: 'idem-key-2',
        confirmOperationHash: prepared.operation.operationHash,
      },
    });

    expect(result.isError).toBeFalsy();
    const urls = fetchImpl.mock.calls.map(([url]) => String(url));
    expect(urls.some(url => url.includes('/draft-entries'))).toBe(true);
    expect(urls.some(url => url.includes('/journals/3/bookdraftentries'))).toBe(true);
  });

  it('re-applies maxAmount at commit when the policy tightened after prepare', async () => {
    enableBooking();
    const client = makeClient();
    const prepared = await prepareBooking(client, { journalNumber: 3, entryNumbers: [11, 12], reason: 'tightened policy' });
    usePolicy({ maxAmount: 1000 });
    await expect(revalidateBookingOperation(client, prepared.operation)).rejects.toThrow('maxAmount 1000');
  });

  it('requires a digits-only journalNumber', async () => {
    enableBooking();
    const client = makeClient();
    const prepared = await prepareBooking(client, { journalNumber: 3, entryNumbers: [13, 14], reason: 'journal shape' });
    const altered = { ...prepared.operation, pathParams: { journalNumber: '3x' } };
    await expect(revalidateBookingOperation(client, altered)).rejects.toThrow('journalNumber');
  });
});

describe('capability routes', () => {
  it('only lets a prepare capability target its own endpoints', () => {
    expect(() =>
      prepareOperation({
        capability: 'economic_prepare_customer_change',
        serviceId: 'journals',
        method: 'POST',
        pathTemplate: '/journals/{journalNumber}/bookdraftentries',
        pathParams: { journalNumber: 3 },
        body: { entryNumbers: [1] },
        reason: 'cross-capability',
      }),
    ).toThrow('cannot target');

    expect(() =>
      prepareOperation({
        capability: 'economic_prepare_product_change',
        serviceId: 'customers',
        method: 'POST',
        pathTemplate: '/Customers',
        body: { name: 'x' },
        reason: 'cross-capability',
      }),
    ).toThrow('cannot target');

    expect(() =>
      prepareOperation({
        capability: 'something_else',
        serviceId: 'customers',
        method: 'POST',
        pathTemplate: '/Customers',
        reason: 'unknown capability',
      }),
    ).toThrow('Unknown write capability');
  });

  it('rejects the wrong capability through the prepare tool', async () => {
    const mcp = await connectTools(makeClient());
    const result = await mcp.callTool({
      name: 'economic_prepare_customer_change',
      arguments: {
        serviceId: 'booked-entries',
        method: 'POST',
        pathTemplate: '/booked-entries/match',
        body: { entryIds: [1, 2] },
        reason: 'wrong route',
      },
    });
    expect(result.isError).toBe(true);
  });

  it('maps every capability route to an allowlisted endpoint', () => {
    for (const routes of Object.values(CAPABILITY_ROUTES)) {
      for (const route of routes) {
        expect(() => findEndpoint(route.serviceId, route.method, route.pathTemplate)).not.toThrow();
      }
    }
  });
});

describe('selfUrl resolution', () => {
  it('maps e-conomic self URLs onto allowlisted read endpoints', () => {
    expect(resolveSelfUrl('https://restapi.e-conomic.com/customers/101')).toMatchObject({
      serviceId: 'rest',
      method: 'GET',
      pathTemplate: '/customers/{number}',
      pathParams: { number: '101' },
    });
    expect(resolveSelfUrl('https://restapi.e-conomic.com/invoices/booked?pagesize=5')).toMatchObject({
      serviceId: 'rest',
      pathTemplate: '/invoices/booked',
      query: { pagesize: '5' },
    });
    expect(resolveSelfUrl('https://apis.e-conomic.com/customersapi/v3.1.0/Customers/7')).toMatchObject({
      serviceId: 'customers',
      pathTemplate: '/Customers/{number}',
    });
  });

  it('rejects non-https, non-default ports, credentials, and non-allowlisted paths', () => {
    expect(() => resolveSelfUrl('http://restapi.e-conomic.com/customers/1')).toThrow();
    expect(() => resolveSelfUrl('https://restapi.e-conomic.com:8443/customers/1')).toThrow();
    expect(() => resolveSelfUrl('https://user:pw@restapi.e-conomic.com/customers/1')).toThrow();
    expect(() => resolveSelfUrl('https://restapi.e-conomic.com/not-a-resource/1')).toThrow();
    expect(() => resolveSelfUrl('https://restapi.e-conomic.com/customers/1%2F..')).toThrow();
    expect(() => resolveSelfUrl('https://example.com/customers/1')).toThrow();
  });

  it('does not fetch a non-https selfUrl through the gateway', async () => {
    const fetchImpl = vi.fn(async () => Response.json({ ok: true }));
    const gateway = createEconomicGateway({
      appSecretToken: 'app',
      agreementGrantToken: 'grant',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await expect(
      gateway.callTool('get_entity', { selfUrl: 'http://restapi.e-conomic.com/customers/1' }),
    ).rejects.toThrow();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('path parameter guard', () => {
  it('rejects dot segments, separators, and encoded separators', () => {
    for (const bad of ['', '.', '..', 'a/b', 'a\\b', 'a?b', 'a#b', '%2e%2e', '%2E', 'x%2fy', 'x%2Fy']) {
      expect(() => assertSafePathParam(bad)).toThrow();
    }
    expect(assertSafePathParam('ABC-1')).toBe('ABC-1');
  });

  it('is applied when materializing endpoint paths', () => {
    const endpoint = findEndpoint('rest', 'GET', '/customers/{number}');
    expect(() => materializePath(endpoint, { number: '..' })).toThrow();
    expect(() => materializePath(endpoint, { number: '%2e%2e' })).toThrow();
    expect(materializePath(endpoint, { number: 42 })).toBe('/customers/42');
  });
});

describe('client base URL', () => {
  it('trims trailing slashes from base URLs', () => {
    const client = new EconomicClient({ appSecretToken: 'a', agreementGrantToken: 'g', restBaseUrl: 'https://x.test///' });
    expect(client.buildRestUrl('/a')).toBe('https://x.test/a');
  });
});

describe('HTTP hardening', () => {
  it('rejects wrong tokens of any length', () => {
    process.env.MCP_HTTP_TOKEN = 'secret';
    for (const header of ['Bearer secre', 'Bearer secret2', 'Bearer x', 'secret']) {
      expect(() => assertAuthorized({ headers: { authorization: header } } as never)).toThrow(HttpRequestError);
    }
    expect(() => assertAuthorized({ headers: { authorization: 'Bearer secret' } } as never)).not.toThrow();
  });

  it('refuses to start when a forwarded user is trusted without MCP_HTTP_TOKEN', () => {
    expect(() => assertSafeHttpStartup({ ECONOMIC_TRUST_FORWARDED_USER: 'true' })).toThrow('MCP_HTTP_TOKEN');
    expect(() =>
      assertSafeHttpStartup({ ECONOMIC_TRUST_FORWARDED_USER: 'true', MCP_HTTP_TOKEN: 't' }),
    ).not.toThrow();
    expect(() => assertSafeHttpStartup({})).not.toThrow();
  });
});
