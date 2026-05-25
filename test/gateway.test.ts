import { describe, expect, it } from 'vitest';
import { createEconomicGateway, economicGatewayTools } from '../src/gateway.js';

describe('e-conomic gateway export', () => {
  it('exposes curated gateway tools without write tools', () => {
    expect(economicGatewayTools.map(tool => tool.name)).toContain('customer_overview');
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
});
