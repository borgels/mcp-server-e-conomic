// VAT set-up in ./gateway (#71): read only; nothing is reported.
import { describe, expect, it } from 'vitest';
import { createEconomicGateway, economicToolCatalog, resolveEconomicReadTarget, type GatewayJsonObject } from '../src/gateway.js';

const context = { credentials: { agreementGrantToken: 'grant-token-for-tests' } };

function fakeEconomic() {
  const paths: string[] = [];
  const gateway = createEconomicGateway({
    appSecretToken: 'app-secret-for-tests',
    fetchImpl: (async (input: string | URL | Request) => {
      paths.push(new URL(String(input instanceof Request ? input.url : input)).pathname);
      return Response.json({ collection: [{ vatCode: 'U25' }], pagination: { results: 1 } });
    }) as typeof fetch,
  });
  return { gateway, paths };
}

describe('vat_overview', () => {
  it('reads VAT codes by default, VAT types and zones, and a type’s VAT return fields', async () => {
    const { gateway, paths } = fakeEconomic();
    for (const input of [
      {},
      { resource: 'vat-types' },
      { resource: 'vat-zones' },
      { resource: 'vat-types', number: 1, reportSetups: true },
    ] as GatewayJsonObject[]) {
      const result = await gateway.callTool('vat_overview', input, context);
      expect(result.isError, JSON.stringify(input)).toBeUndefined();
    }
    expect(paths).toEqual(['/vat-accounts', '/vat-types', '/vat-zones', '/vat-types/1/vat-report-setups']);
  });

  it('answers the report set-up with a count, not as one record', async () => {
    const { gateway } = fakeEconomic();
    const result = await gateway.callTool('vat_overview', { resource: 'vat-types', number: 1, reportSetups: true }, context);
    expect(result.content[0]?.text.split('\n\n')[0]).toBe('vat_overview: 1 record from rest:vat-types.');
  });

  it('refuses report set-ups without a type or on another resource', () => {
    for (const input of [
      { resource: 'vat-types', reportSetups: true },
      { resource: 'vat-zones', number: 1, reportSetups: true },
      { resource: 'vat-types', number: 1, reportSetups: 'yes' },
    ] as GatewayJsonObject[]) {
      expect(resolveEconomicReadTarget('vat_overview', input).ok, JSON.stringify(input)).toBe(false);
    }
  });

  it('is a read tool that reads only VAT resources', () => {
    const tool = economicToolCatalog.find(entry => entry.name === 'vat_overview')!;
    expect(tool.riskLevel).toBe('read');
    expect(tool.upstream.every(operation => operation.method === 'GET' && operation.path.startsWith('/vat-'))).toBe(true);
  });
});
