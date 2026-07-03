import { describe, expect, it, vi } from 'vitest';
import { createEconomicGateway, economicGatewayTools } from '../src/gateway.js';

describe('e-conomic gateway export', () => {
  it('exposes curated gateway tools with writes gated off by default', () => {
    expect(economicGatewayTools.map(tool => [tool.name, tool.riskLevel, tool.enabledByDefault])).toEqual([
      ['check_connection', 'read', true],
      ['company_context', 'read', true],
      ['search_entities', 'read', true],
      ['get_entity', 'read', true],
      ['customer_overview', 'read', true],
      ['supplier_overview', 'read', true],
      ['product_overview', 'read', true],
      ['report_data', 'read', true],
      ['invoice_overview', 'read', true],
      ['project_overview', 'read', true],
      ['accounting_entries', 'read', true],
      ['create_draft_invoice', 'write', false],
      ['upsert_customer', 'write', false],
      ['upsert_product', 'write', false],
      ['upsert_project', 'write', false],
      ['create_time_entry', 'write', false],
    ]);
    // Write tools must never be enabled by default.
    const writeTools = economicGatewayTools.filter(tool => tool.riskLevel !== 'read');
    expect(writeTools.map(tool => tool.name)).toEqual([
      'create_draft_invoice',
      'upsert_customer',
      'upsert_product',
      'upsert_project',
      'create_time_entry',
    ]);
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

  it('lists booked invoices in contract mode', async () => {
    const gateway = createEconomicGateway({ contractMode: true });
    const result = await gateway.callTool('invoice_overview', {});
    expect(result.isError).toBeUndefined();
    const sc = result.structuredContent as { mode: string; collection: Array<Record<string, unknown>> };
    expect(sc.mode).toBe('contract');
    expect(sc.collection[0]).toMatchObject({ bookedInvoiceNumber: 70001, remainder: 10000 });
  });

  it('reads booked invoices live via the REST invoices/booked collection', async () => {
    const requests: Request[] = [];
    const gateway = createEconomicGateway({
      appSecretToken: 'app',
      agreementGrantToken: 'grant',
      fetchImpl: async (input, init) => {
        requests.push(new Request(input, init));
        return Response.json({ collection: [{ bookedInvoiceNumber: 70001 }] });
      },
    });

    const result = await gateway.callTool('invoice_overview', { query: { pagesize: 5 } });
    expect(result.isError).toBeUndefined();
    expect(requests[0]?.url).toContain('/invoices/booked');
    expect(requests[0]?.url).toContain('pagesize=5');
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
      enableWrites: true,
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

  it('blocks write tools unless the embedder enables writes', async () => {
    const fetchMock = vi.fn<typeof fetch>();
    const gateway = createEconomicGateway({
      appSecretToken: 'app',
      agreementGrantToken: 'grant',
      fetchImpl: async (input, init) => {
        const request = new Request(input, init);
        if (request.method !== 'GET') {
          fetchMock(input, init);
        }
        return Response.json({
          customerNumber: 1000,
          name: 'Moebelfabrikken A/S',
          currency: 'DKK',
          paymentTerms: { paymentTermsNumber: 5 },
          vatZone: { vatZoneNumber: 1 },
          collection: [{ layoutNumber: 19 }],
        });
      },
    });

    const draft = await gateway.callTool('create_draft_invoice', {
      customerNumber: 1000,
      lines: [{ productNumber: '1', quantity: 1, unitNetPrice: 1000 }],
    });
    expect(draft).toMatchObject({ isError: true });
    expect(draft.content[0]?.text).toMatch(/writes disabled/);

    const customer = await gateway.callTool('upsert_customer', {
      name: 'Ny Kunde ApS',
      currency: 'DKK',
      customerGroupNumber: 1,
      paymentTermsNumber: 1,
      vatZoneNumber: 1,
    });
    expect(customer).toMatchObject({ isError: true });
    expect(customer.content[0]?.text).toMatch(/writes disabled/);

    // Nothing mutating reached the API.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('creates a customer with nested reference objects', async () => {
    const calls: Array<{ method: string; url: string; body?: unknown }> = [];
    const gateway = createEconomicGateway({
      appSecretToken: 'app',
      agreementGrantToken: 'grant',
      enableWrites: true,
      fetchImpl: async (input, init) => {
        const request = new Request(input, init);
        const body = request.method === 'POST' ? await request.clone().json() : undefined;
        calls.push({ method: request.method, url: request.url, body });
        return Response.json({ customerNumber: 1042, name: 'Ny Kunde ApS' });
      },
    });

    const result = await gateway.callTool('upsert_customer', {
      name: 'Ny Kunde ApS',
      currency: 'DKK',
      customerGroupNumber: 1,
      paymentTermsNumber: 5,
      vatZoneNumber: 1,
      email: 'faktura@nykunde.dk',
      corporateIdentificationNumber: '12345678',
    });

    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toMatchObject({ customerNumber: 1042 });
    const post = calls.find(call => call.method === 'POST');
    expect(post?.url).toContain('/customers');
    expect(post?.body).toMatchObject({
      name: 'Ny Kunde ApS',
      currency: 'DKK',
      customerGroup: { customerGroupNumber: 1 },
      paymentTerms: { paymentTermsNumber: 5 },
      vatZone: { vatZoneNumber: 1 },
      email: 'faktura@nykunde.dk',
      corporateIdentificationNumber: '12345678',
    });
  });

  it('rejects customer creation without the required master data fields', async () => {
    const gateway = createEconomicGateway({
      appSecretToken: 'app',
      agreementGrantToken: 'grant',
      enableWrites: true,
    });

    const result = await gateway.callTool('upsert_customer', { name: 'Ny Kunde ApS' });
    expect(result).toMatchObject({ isError: true });
    expect(result.content[0]?.text).toMatch(/requires name, currency, customerGroupNumber/);
  });

  it('updates a customer by merging provided fields into the existing object', async () => {
    const calls: Array<{ method: string; url: string; body?: unknown }> = [];
    const gateway = createEconomicGateway({
      appSecretToken: 'app',
      agreementGrantToken: 'grant',
      enableWrites: true,
      fetchImpl: async (input, init) => {
        const request = new Request(input, init);
        const body = request.method === 'PUT' ? await request.clone().json() : undefined;
        calls.push({ method: request.method, url: request.url, body });
        if (request.method === 'GET') {
          return Response.json({
            customerNumber: 1001,
            name: 'Demo Servicekunde ApS',
            currency: 'DKK',
            email: 'gammel@demo.dk',
            customerGroup: { customerGroupNumber: 1 },
            paymentTerms: { paymentTermsNumber: 1 },
            vatZone: { vatZoneNumber: 1 },
          });
        }
        return Response.json({ customerNumber: 1001, name: 'Demo Servicekunde ApS', email: 'ny@demo.dk' });
      },
    });

    const result = await gateway.callTool('upsert_customer', {
      customerNumber: 1001,
      email: 'ny@demo.dk',
      paymentTermsNumber: 2,
    });

    expect(result.isError).toBeUndefined();
    const put = calls.find(call => call.method === 'PUT');
    expect(put?.url).toContain('/customers/1001');
    expect(put?.body).toMatchObject({
      customerNumber: 1001,
      name: 'Demo Servicekunde ApS',
      currency: 'DKK',
      email: 'ny@demo.dk',
      paymentTerms: { paymentTermsNumber: 2 },
      vatZone: { vatZoneNumber: 1 },
    });
  });

  it('creates a product when the product number does not exist yet', async () => {
    const calls: Array<{ method: string; url: string; body?: unknown }> = [];
    const gateway = createEconomicGateway({
      appSecretToken: 'app',
      agreementGrantToken: 'grant',
      enableWrites: true,
      fetchImpl: async (input, init) => {
        const request = new Request(input, init);
        const body = request.method === 'POST' ? await request.clone().json() : undefined;
        calls.push({ method: request.method, url: request.url, body });
        if (request.method === 'GET') {
          return new Response(JSON.stringify({ message: 'Not found' }), {
            status: 404,
            headers: { 'content-type': 'application/json' },
          });
        }
        return Response.json({ productNumber: 'KONSULENT', name: 'Konsulenttime' });
      },
    });

    const result = await gateway.callTool('upsert_product', {
      productNumber: 'KONSULENT',
      name: 'Konsulenttime',
      productGroupNumber: 1,
      salesPrice: 1250,
    });

    expect(result.isError).toBeUndefined();
    const post = calls.find(call => call.method === 'POST');
    expect(post?.url).toContain('/products');
    expect(post?.body).toMatchObject({
      productNumber: 'KONSULENT',
      name: 'Konsulenttime',
      productGroup: { productGroupNumber: 1 },
      salesPrice: 1250,
    });
  });

  it('updates an existing product via full-object PUT with merged fields', async () => {
    const calls: Array<{ method: string; url: string; body?: unknown }> = [];
    const gateway = createEconomicGateway({
      appSecretToken: 'app',
      agreementGrantToken: 'grant',
      enableWrites: true,
      fetchImpl: async (input, init) => {
        const request = new Request(input, init);
        const body = request.method === 'PUT' ? await request.clone().json() : undefined;
        calls.push({ method: request.method, url: request.url, body });
        if (request.method === 'GET') {
          return Response.json({
            productNumber: 'TIME-TECH',
            name: 'Teknikertime',
            salesPrice: 875,
            productGroup: { productGroupNumber: 1 },
          });
        }
        return Response.json({ productNumber: 'TIME-TECH', salesPrice: 925 });
      },
    });

    const result = await gateway.callTool('upsert_product', {
      productNumber: 'TIME-TECH',
      salesPrice: 925,
    });

    expect(result.isError).toBeUndefined();
    const put = calls.find(call => call.method === 'PUT');
    expect(put?.url).toContain('/products/TIME-TECH');
    expect(put?.body).toMatchObject({
      productNumber: 'TIME-TECH',
      name: 'Teknikertime',
      salesPrice: 925,
      productGroup: { productGroupNumber: 1 },
    });
  });

  it('serves deterministic upsert fixtures in contract mode', async () => {
    const fetchMock = vi.fn<typeof fetch>();
    const gateway = createEconomicGateway({
      contractMode: true,
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    const created = await gateway.callTool('upsert_customer', { name: 'Ny Kunde ApS', currency: 'DKK' });
    expect(created.structuredContent).toMatchObject({ mode: 'contract', action: 'created', customerNumber: 1003 });

    const updated = await gateway.callTool('upsert_product', { productNumber: 'TIME-TECH', salesPrice: 925 });
    expect(updated.structuredContent).toMatchObject({ mode: 'contract', action: 'updated', productNumber: 'TIME-TECH' });

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('reads the projects OpenAPI service via project_overview', async () => {
    const requests: Request[] = [];
    const gateway = createEconomicGateway({
      appSecretToken: 'app',
      agreementGrantToken: 'grant',
      fetchImpl: async (input, init) => {
        requests.push(new Request(input, init));
        return Response.json({ collection: [{ projectNumber: 5001 }] });
      },
    });

    // TimeEntries resource selects a different projects resource on the OpenAPI surface.
    const result = await gateway.callTool('project_overview', { resource: 'TimeEntries' });
    expect(result.isError).toBeUndefined();
    expect(requests[0]?.url).toContain('apis.e-conomic.com/projectsapi/v1.1.0/TimeEntries/paged');
  });

  it('registers a project time entry via POST /TimeEntries when writes are enabled', async () => {
    const calls: Array<{ method: string; url: string; body?: unknown }> = [];
    const gateway = createEconomicGateway({
      appSecretToken: 'app',
      agreementGrantToken: 'grant',
      enableWrites: true,
      fetchImpl: async (input, init) => {
        const request = new Request(input, init);
        const body = request.method === 'POST' ? await request.clone().json() : undefined;
        calls.push({ method: request.method, url: request.url, body });
        return Response.json({ timeEntryNumber: 900001 });
      },
    });

    const result = await gateway.callTool('create_time_entry', {
      projectNumber: 5001,
      activityNumber: 3,
      employeeNumber: 10,
      date: '2026-05-02',
      hours: 4,
    });

    expect(result.isError).toBeUndefined();
    const post = calls.find(call => call.method === 'POST');
    expect(post?.url).toContain('/projectsapi/v1.1.0/TimeEntries');
    expect(post?.body).toMatchObject({
      date: '2026-05-02',
      hours: 4,
      project: { projectNumber: 5001 },
      activity: { activityNumber: 3 },
      employee: { employeeNumber: 10 },
    });
  });

  it('blocks time-entry registration unless the embedder enables writes', async () => {
    const gateway = createEconomicGateway({ appSecretToken: 'app', agreementGrantToken: 'grant' });
    const result = await gateway.callTool('create_time_entry', {
      projectNumber: 5001,
      activityNumber: 3,
      employeeNumber: 10,
      date: '2026-05-02',
      hours: 4,
    });
    expect(result).toMatchObject({ isError: true });
    expect(result.content[0]?.text).toMatch(/writes disabled/);
  });

  it('creates a project via collection POST and updates via merged collection PUT', async () => {
    const calls: Array<{ method: string; url: string; body?: unknown }> = [];
    const gateway = createEconomicGateway({
      appSecretToken: 'app',
      agreementGrantToken: 'grant',
      enableWrites: true,
      fetchImpl: async (input, init) => {
        const request = new Request(input, init);
        const body = request.method === 'PUT' ? await request.clone().json() : undefined;
        calls.push({ method: request.method, url: request.url, body });
        if (request.method === 'GET') {
          return Response.json({
            projectNumber: 5001,
            name: 'Servicekontrakt Nord',
            projectGroup: { projectGroupNumber: 1 },
            customer: { customerNumber: 1001 },
            responsibleEmployee: { employeeNumber: 10 },
            objectVersion: 'abc',
          });
        }
        return Response.json({ projectNumber: 5001 });
      },
    });

    const result = await gateway.callTool('upsert_project', { projectNumber: 5001, description: 'Ny beskrivelse' });
    expect(result.isError).toBeUndefined();
    const put = calls.find(call => call.method === 'PUT');
    expect(put?.url).toContain('/projectsapi/v1.1.0/Projects');
    // Read-merge-write keeps objectVersion + existing refs while applying the change.
    expect(put?.body).toMatchObject({
      projectNumber: 5001,
      name: 'Servicekontrakt Nord',
      description: 'Ny beskrivelse',
      objectVersion: 'abc',
      responsibleEmployee: { employeeNumber: 10 },
    });
  });

  it('rejects project creation without the required fields', async () => {
    const gateway = createEconomicGateway({ appSecretToken: 'app', agreementGrantToken: 'grant', enableWrites: true });
    const result = await gateway.callTool('upsert_project', { name: 'Kun navn' });
    expect(result).toMatchObject({ isError: true });
    expect(result.content[0]?.text).toMatch(/requires name, projectGroupNumber/);
  });

  it('serves deterministic project fixtures in contract mode', async () => {
    const gateway = createEconomicGateway({ contractMode: true });
    const projects = await gateway.callTool('project_overview', {});
    const sc = projects.structuredContent as { mode: string; collection: Array<Record<string, unknown>> };
    expect(sc.mode).toBe('contract');
    expect(sc.collection[0]).toMatchObject({ projectNumber: 5001 });

    const time = await gateway.callTool('create_time_entry', {
      projectNumber: 5001,
      activityNumber: 3,
      employeeNumber: 10,
      date: '2026-05-02',
      hours: 4,
    });
    expect(time.structuredContent).toMatchObject({ mode: 'contract', project: { projectNumber: 5001 }, hours: 4 });
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
