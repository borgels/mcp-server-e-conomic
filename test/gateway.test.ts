import { describe, expect, it, vi } from 'vitest';
import { createEconomicGateway, economicGatewayTools } from '../src/gateway.js';

describe('e-conomic gateway export', () => {
  it('exposes curated gateway tools with draft creation gated off by default', () => {
    expect(economicGatewayTools.map(tool => [tool.name, tool.riskLevel, tool.enabledByDefault])).toEqual([
      ['check_connection', 'read', true],
      ['company_context', 'read', true],
      ['search_entities', 'read', true],
      ['get_entity', 'read', true],
      ['customer_overview', 'read', true],
      ['supplier_overview', 'read', true],
      ['product_overview', 'read', true],
      ['report_data', 'read', true],
      ['create_draft_invoice', 'write', false],
    ]);
    // The only write tool must never be enabled by default.
    const writeTools = economicGatewayTools.filter(tool => tool.riskLevel !== 'read');
    expect(writeTools.map(tool => tool.name)).toEqual(['create_draft_invoice']);
    expect(writeTools.every(tool => tool.enabledByDefault === false)).toBe(true);
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

  it('creates a deterministic draft invoice in contract mode', async () => {
    const gateway = createEconomicGateway({ contractMode: true });

    const result = await gateway.callTool('create_draft_invoice', {
      customerNumber: 1001,
      lines: [
        { productNumber: 'TIME-TECH', description: 'Teknikertimer', quantity: 2, unitNetPrice: 875 },
        { productNumber: 'MAT-PUMP', quantity: 1, unitNetPrice: 2400 },
      ],
    });

    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toMatchObject({
      mode: 'contract',
      draftInvoiceNumber: 91001,
      customer: { customerNumber: 1001 },
      netAmount: 4150,
      grossAmount: 5187.5,
    });
  });

  it('rejects draft lines without a product reference', async () => {
    const gateway = createEconomicGateway({ contractMode: false, appSecretToken: 'a', agreementGrantToken: 'g' });
    const result = await gateway.callTool('create_draft_invoice', {
      customerNumber: 1000,
      lines: [{ quantity: 1, unitNetPrice: 1000 }],
    });
    expect(result).toMatchObject({ isError: true });
    expect(result.content[0]?.text).toMatch(/productNumber/);
  });

  it('resolves draft defaults from the customer and posts to /invoices/drafts', async () => {
    const calls: Array<{ method: string; url: string; body?: unknown }> = [];
    const gateway = createEconomicGateway({
      appSecretToken: 'app',
      agreementGrantToken: 'grant',
      fetchImpl: async (input, init) => {
        const request = new Request(input, init);
        const url = request.url;
        const method = request.method;
        const body = method === 'POST' ? await request.clone().json() : undefined;
        calls.push({ method, url, body });
        if (method === 'GET' && url.includes('/customers/1000')) {
          return Response.json({
            customerNumber: 1000,
            name: 'Moebelfabrikken A/S',
            currency: 'DKK',
            paymentTerms: { paymentTermsNumber: 5 },
            vatZone: { vatZoneNumber: 1 },
          });
        }
        return Response.json({ draftInvoiceNumber: 30100, netAmount: 1000, grossAmount: 1250 });
      },
    });

    const result = await gateway.callTool('create_draft_invoice', {
      customerNumber: 1000,
      layoutNumber: 19,
      lines: [{ productNumber: '1', description: 'Uninvoiced work', quantity: 1, unitNetPrice: 1000 }],
    });

    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toMatchObject({ draftInvoiceNumber: 30100 });

    const post = calls.find(call => call.method === 'POST');
    expect(post?.url).toContain('/invoices/drafts');
    expect(post?.body).toMatchObject({
      currency: 'DKK',
      customer: { customerNumber: 1000 },
      paymentTerms: { paymentTermsNumber: 5 },
      recipient: { name: 'Moebelfabrikken A/S', vatZone: { vatZoneNumber: 1 } },
      layout: { layoutNumber: 19 },
      lines: [{ lineNumber: 1, product: { productNumber: '1' }, quantity: 1, unitNetPrice: 1000 }],
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
