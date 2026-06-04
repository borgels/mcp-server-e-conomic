import { describe, expect, it, vi } from 'vitest';
import { createEconomicGateway, economicGatewayTools } from '../src/gateway.js';

describe('e-conomic gateway export', () => {
  it('exposes curated gateway tools without write tools', () => {
    expect(economicGatewayTools.map(tool => [tool.name, tool.riskLevel, tool.enabledByDefault])).toEqual([
      ['check_connection', 'read', true],
      ['company_context', 'read', true],
      ['search_entities', 'read', true],
      ['get_entity', 'read', true],
      ['customer_overview', 'read', true],
      ['supplier_overview', 'read', true],
      ['product_overview', 'read', true],
      ['report_data', 'read', true],
    ]);
    expect(economicGatewayTools.every(tool => tool.riskLevel === 'read')).toBe(true);
  });

  it('calls the configured client with supplied credentials', async () => {
    const requests: Request[] = [];
    const gateway = createEconomicGateway({
      appSecretToken: 'app',
      agreementGrantToken: 'grant',
      fetchImpl: async (input, init) => {
        requests.push(new Request(input, init));
        return Response.json({ ok: true });
      },
    });

    const result = await gateway.callTool('check_connection');
    expect(result.structuredContent).toEqual({ ok: true });
    expect(requests[0]?.headers.get('X-AppSecretToken')).toBe('app');
    expect(requests[0]?.headers.get('X-AgreementGrantToken')).toBe('grant');
  });

  it('serves deterministic contract fixtures without live credentials or fetch', async () => {
    const fetchMock = vi.fn<typeof fetch>();
    const gateway = createEconomicGateway({
      contractMode: true,
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    const result = await gateway.callTool('customer_overview', {
      number: 1001,
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toMatchObject({
      mode: 'contract',
      collection: [
        {
          customerNumber: 1001,
          name: 'Demo Servicekunde ApS',
        },
      ],
      pagination: {
        deterministic: true,
      },
    });
  });

  it('keeps get_entity input validation in contract mode', async () => {
    const gateway = createEconomicGateway({ contractMode: true });

    await expect(gateway.callTool('get_entity')).resolves.toMatchObject({
      isError: true,
      content: [{ type: 'text', text: 'Provide either selfUrl or serviceId, resource, and number.' }],
    });
  });

  it('surfaces formatted upstream failures without leaking credentials', async () => {
    const gateway = createEconomicGateway({
      appSecretToken: 'app-secret',
      agreementGrantToken: 'grant-token',
      restBaseUrl: 'https://example.test',
      fetchImpl: async () =>
        new Response(JSON.stringify({ message: 'No access for X-AppSecretToken: app-secret' }), {
          status: 401,
          headers: {
            'content-type': 'application/json',
          },
        }),
    });

    await expect(gateway.callTool('check_connection')).rejects.toThrow(/HTTP 401/);
    await expect(gateway.callTool('check_connection')).rejects.not.toThrow(/app-secret|grant-token/);
  });
});
