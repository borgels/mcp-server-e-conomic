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

type CallResult = Awaited<ReturnType<ReturnType<typeof createEconomicGateway>['callTool']>>;

/** The summary line of a successful result's text block. */
function summaryLine(result: CallResult): string {
  return result.content[0]!.text.split('\n\n')[0]!;
}

/** A successful result carries exactly its structured content as compact JSON after the summary. */
function expectDataInText(result: CallResult, label?: string): void {
  expect(result.structuredContent, label).toBeDefined();
  expect(result.content, label).toHaveLength(1);
  const text = result.content[0]!.text;
  expect(text, label).toBe(`${summaryLine(result)}\n\n${JSON.stringify(result.structuredContent)}`);
}

const NARROW_READ_TOOLS = [
  'search_entities',
  'customer_overview',
  'supplier_overview',
  'product_overview',
  'report_data',
  'invoice_overview',
  'project_overview',
  'accounting_entries',
  'quote_overview',
  'order_overview',
  'subscription_overview',
  'dimension_overview',
  'vat_overview',
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

/** The distinct serviceId:resource pairs a tool's catalog entry declares as reads. */
function readTargets(name: string): Array<{ serviceId: string; resource: string }> {
  const seen = new Map<string, { serviceId: string; resource: string }>();
  for (const operation of catalogEntry(name).upstream) {
    if (operation.access !== 'read') continue;
    // The read of /self that a tool needing a module makes after a failure is not a target.
    if (operation.path === '/self' && name !== 'check_connection' && name !== 'company_context') continue;
    seen.set(`${operation.serviceId}:${operation.resource}`, { serviceId: operation.serviceId, resource: operation.resource });
  }
  return [...seen.values()];
}

const allResources = economicServiceCatalog.services.flatMap(service =>
  service.resources.map(resource => ({ serviceId: service.id, resource })),
);

describe('fixed read targets per tool', () => {
  it('lets every narrow tool read each of its listed targets, at that target', async () => {
    for (const name of NARROW_READ_TOOLS) {
      for (const target of readTargets(name)) {
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
      const allowed = new Set(readTargets(name).map(target => `${target.serviceId}:${target.resource}`));
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
    expect(readTargets('get_entity')).toEqual(allResources);
    // Every read endpoint, plus the read of the agreement's modules (/self) after a failed read of a module's data.
    const upstream = catalogEntry('get_entity').upstream;
    expect(upstream.filter(operation => operation.path !== '/self')).toHaveLength(
      economicServiceCatalog.endpoints.filter(endpoint => endpoint.access === 'read').length,
    );
    expect(upstream.filter(operation => operation.path === '/self')).toEqual([
      { access: 'read', method: 'GET', path: '/self', serviceId: 'rest', resource: 'self' },
    ]);
    expect(catalogEntry('get_entity').title).toMatch(/broad/i);

    const { gateway, requests } = recordingGateway(() => Response.json({ entryNumber: 1 }));
    const result = await gateway.callTool(
      'get_entity',
      { serviceId: 'booked-entries', resource: 'booked-entries', number: 1 },
      context('grant-token-for-tests'),
    );
    expect(result.isError).toBeUndefined();
    expect(new URL(requests[0]!.url).pathname).toBe('/bookedEntriesapi/v7.0.0/booked-entries/1');

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

  it('maps a get_entity self URL for the products page to the products resource (#61)', () => {
    expect(resolveEconomicReadTarget('get_entity', { selfUrl: 'https://apis.e-conomic.com/productsapi/v2.1.0/productspaged/paged' })).toEqual({
      ok: true,
      target: { serviceId: 'products', resource: 'products', method: 'GET', pathTemplate: '/productspaged/paged' },
    });
    const upstream = catalogEntry('get_entity').upstream.filter(operation => operation.path === '/productsapi/v2.1.0/productspaged/paged');
    expect(upstream).toEqual([{ access: 'read', method: 'GET', path: '/productsapi/v2.1.0/productspaged/paged', serviceId: 'products', resource: 'products' }]);
  });
});

describe('declared upstream requests', () => {
  /** Turns a declared path template into a pattern for an actual request path. */
  function pattern(path: string): RegExp {
    const escaped = path
      .split(/\{[^}]+\}/)
      .map(part => part.replace(/[.*+?^$()|[\]\\]/g, '\\$&'))
      .join('[^/]+');
    return new RegExp(`^${escaped}$`);
  }

  /** Answers a plausible e-conomic body for each request so write tools reach their write. */
  function upstreamResponse(request: Request): Response {
    const path = new URL(request.url).pathname;
    if (request.method === 'GET' && path === '/layouts') return Response.json({ collection: [{ layoutNumber: 1 }] });
    if (request.method === 'GET' && path.startsWith('/customers/')) {
      return Response.json({ name: 'C', currency: 'DKK', paymentTerms: { paymentTermsNumber: 1 }, vatZone: { vatZoneNumber: 1 } });
    }
    if (request.method === 'GET' && /^\/(products\/NEW|accounts\/2000)$/.test(path)) return new Response('', { status: 404 });
    if (request.method === 'GET' && path === '/accounting-years') {
      return Response.json({
        collection: [
          { year: '2025', fromDate: '2025-01-01', toDate: '2025-12-31', self: 'https://restapi.e-conomic.com/accounting-years/2025' },
          { year: '2026', fromDate: '2026-01-01', toDate: '2026-12-31', self: 'https://restapi.e-conomic.com/accounting-years/2026' },
        ],
      });
    }
    if (request.method === 'GET' && path.endsWith('/draft-entries')) {
      return Response.json({
        items: [
          { entryNumber: 11, journalNumber: 1, voucherNumber: 501, date: '2026-03-02', amount: 100 },
          { entryNumber: 12, journalNumber: 1, voucherNumber: 501, date: '2026-03-02', amount: -100 },
        ],
      });
    }
    if (request.method === 'GET' && path.endsWith('/pdf')) {
      return new Response(new Uint8Array([0x25, 0x50, 0x44, 0x46]), { headers: { 'content-type': 'application/pdf' } });
    }
    if (request.method === 'GET' && path.endsWith('/AttachedDocuments') && new URL(request.url).searchParams.has('filter')) {
      return Response.json({ items: [{ number: 6001, voucherNumber: 501, accountingYear: '2026' }] });
    }
    if (request.method === 'GET' && path.startsWith('/invoices/drafts/')) return Response.json({ draftInvoiceNumber: 7 });
    if (request.method === 'GET' && /\/draft-entries\/11$/.test(path)) return Response.json({ entryNumber: 11, journalNumber: 1, voucherNumber: 501 });
    if (request.method === 'GET' && /^\/(quotes|orders)\/drafts\/\d+$/.test(path)) return Response.json({ quoteNumber: 3, orderNumber: 4, customer: { customerNumber: 1 } });
    if (request.method === 'GET' && /^\/(quotes|orders)\/(sent|archived)\/(3|4)$/.test(path)) return new Response('', { status: 404 });
    if (request.method === 'GET' && /\/TimeEntries\/\d+$/.test(path)) {
      return Response.json({ number: 5, projectNumber: 1, activityNumber: 1, employeeNumber: 1, isApproved: false, isReconciled: false });
    }
    if (request.method === 'GET' && path.startsWith('/invoices/booked/')) {
      return Response.json({
        bookedInvoiceNumber: 70001,
        currency: 'DKK',
        customer: { customerNumber: 1 },
        paymentTerms: { paymentTermsNumber: 1 },
        layout: { layoutNumber: 19 },
        recipient: { name: 'C', vatZone: { vatZoneNumber: 1 } },
        lines: [{ lineNumber: 1, product: { productNumber: 'P1' }, quantity: 2, unitNetPrice: 100 }],
      });
    }
    if (request.method === 'GET' && path.endsWith('/upgrade-instructions/order')) return Response.json({ order: { customer: { customerNumber: 1 } } });
    if (request.method === 'GET' && path.endsWith('/upgrade-instructions/draftInvoice')) {
      return Response.json({ draftInvoice: { customer: { customerNumber: 1 } } });
    }
    return Response.json({ collection: [] });
  }

  const writeInputs: Record<string, GatewayJsonObject[]> = {
    create_draft_invoice: [{ customerNumber: 1, lines: [{ productNumber: 'P1', quantity: 1 }] }],
    update_draft_invoice: [{ draftInvoiceNumber: 7, date: '2026-03-02', lines: [{ productNumber: 'P1', quantity: 2 }] }, { draftInvoiceNumber: 7, reference: 'PO 12' }],
    create_credit_note_draft: [{ bookedInvoiceNumber: 70001 }, { bookedInvoiceNumber: 70001, lineNumbers: [1], date: '2026-03-02' }],
    create_draft_quote: [{ customerNumber: 1, lines: [{ productNumber: 'P1', quantity: 1 }] }],
    create_draft_order: [{ customerNumber: 1, lines: [{ productNumber: 'P1', quantity: 1 }] }],
    update_draft_quote: [{ quoteNumber: 3, reference: 'PO 12' }, { quoteNumber: 3, customerNumber: 2, lines: [{ productNumber: 'P1', quantity: 2 }] }],
    update_draft_order: [{ orderNumber: 4, date: '2026-03-02' }, { orderNumber: 4, customerNumber: 2 }],
    upgrade_quote: [{ quoteNumber: 3, to: 'order' }, { quoteNumber: 3, to: 'draftInvoice' }],
    upgrade_order: [{ orderNumber: 4 }],
    set_entry_dimensions: [
      { target: 'draftEntry', journalNumber: 1, entryNumber: 11, dimensionNumber: 1, dimensionKey: 2 },
      { target: 'salesDocumentLine', documentNumber: 7, lineNumber: 1, dimensionNumber: 1, dimensionKey: 3, isDistribution: true },
    ],
    add_subscriber: [{ subscriptionNumber: 1, customerNumber: 2, startDate: '2026-01-01', endDate: '2026-03-31', expiryDate: '2026-12-31', discountPercentage: 10 }],
    end_subscriber: [{ subscriberNumber: 3, expiryDate: '2026-12-31' }],
    update_time_entry: [{ timeEntryNumber: 5, hours: 3.5, date: '2026-03-02', description: 'Rettet' }],
    create_mileage_entry: [{ projectNumber: 1, employeeNumber: 2, date: '2026-03-02', distance: 42, from: 'A', to: 'B' }],
    approve_time_entries: [{ timeEntryNumbers: [5, 6] }],
    attach_voucher_file: [
      { accountingYear: '2026', voucherNumber: 501, contentType: 'application/pdf', fileBase64: 'JVBERi0xLjcK' },
      { accountingYear: '2025/2026', voucherNumber: 501, contentType: 'image/png', fileBase64: 'iVBORw0KGgo=', onConflict: 'merge' },
    ],
    upsert_customer: [
      { name: 'C', currency: 'DKK', customerGroupNumber: 1, paymentTermsNumber: 1, vatZoneNumber: 1 },
      { customerNumber: 1, name: 'C' },
    ],
    upsert_product: [{ productNumber: 'NEW', name: 'P', productGroupNumber: 1 }, { productNumber: 'P1', name: 'P' }],
    upsert_project: [
      { name: 'P', projectGroupNumber: 1, customerNumber: 1, responsibleEmployeeNumber: 1 },
      { projectNumber: 1, name: 'P' },
    ],
    create_time_entry: [{ projectNumber: 1, activityNumber: 1, employeeNumber: 1, date: '2026-01-02', hours: 1 }],
    upsert_supplier: [
      { name: 'S', currency: 'DKK', supplierGroupNumber: 1, paymentTermsNumber: 1, vatZoneNumber: 1 },
      { supplierNumber: 1, name: 'S' },
    ],
    upsert_employee: [{ name: 'E' }, { employeeNumber: 1, name: 'E' }],
    upsert_account: [{ accountNumber: 2000, name: 'A', accountType: 'status' }, { accountNumber: 1000, name: 'A' }],
    create_journal_entries: [
      {
        journalNumber: 1,
        entries: [
          { type: 'financeVoucher', date: '2026-03-02', amount: 100, accountNumber: 1010, contraAccountNumber: 5820 },
          { type: 'supplierInvoice', date: '2026-03-02', amount: -250.5, supplierNumber: 2001, supplierInvoiceNumber: 'F-77' },
        ],
      },
      { journalNumber: 1, accountingYear: '2026', entries: [{ type: 'financeVoucher', date: '2026-03-02', amount: 1, accountNumber: 1010 }] },
    ],
    register_payment: [
      { journalNumber: 1, kind: 'customerPayment', date: '2026-03-02', amount: -1250, customerNumber: 1001, customerInvoiceNumber: 70001, contraAccountNumber: 5820 },
      { journalNumber: 1, kind: 'supplierPayment', date: '2026-03-02', amount: 250.5, supplierNumber: 2001, supplierInvoiceNumber: 'F-77', contraAccountNumber: 5820 },
    ],
    book_journal_entries: [
      { journalNumber: 1, entryNumbers: [11, 12] },
      { journalNumber: 1, voucherNumbers: [501] },
    ],
    book_journal: [{ journalNumber: 1, entryCount: 2 }, { journalNumber: 1, entryCount: 2, requireVoucher: false }],
    book_invoice: [{ draftInvoiceNumber: 7 }],
    match_open_items: [{ entryIds: [800001, 800002] }],
    delete_journal_entry: [{ journalNumber: 1, entryNumber: 11 }],
    delete_draft_invoice: [{ draftInvoiceNumber: 7 }],
    delete_draft_quote: [{ quoteNumber: 3 }],
    delete_draft_order: [{ orderNumber: 4 }],
    delete_time_entry: [{ timeEntryNumber: 5 }],
  };

  function inputsFor(name: string): GatewayJsonObject[] {
    if (writeInputs[name]) return writeInputs[name]!;
    if (name === 'check_connection' || name === 'company_context') return [{}];
    if (name === 'key_figures') return [{}, { accountingYear: '2026', period: 3 }, { accountingYear: '2025', compare: false }];
    if (name === 'get_entity') {
      return [
        ...allResources.map(target => ({ ...target, number: 1 })),
        { selfUrl: 'https://restapi.e-conomic.com/invoices/booked/70001' },
        { selfUrl: 'https://apis.e-conomic.com/documentsapi/v4.0.2/AttachedDocuments/5/pdf' },
        { selfUrl: 'https://apis.e-conomic.com/customersapi/v3.1.0/Customers/paged' },
        { selfUrl: 'https://apis.e-conomic.com/productsapi/v2.1.0/productspaged/paged' },
      ];
    }
    return readTargets(name).flatMap(target => [{ ...target }, { ...target, number: 7 }, { ...target, paged: false }]);
  }

  it('passes a refused access (HTTP 401) on as e-conomic\'s own error, for every tool that sends a request', async () => {
    for (const entry of economicToolCatalog) {
      if (entry.name === 'upsert_account') continue;
      const gateway = createEconomicGateway({
        appSecretToken: 'app-secret-for-tests',
        policy: { enableWrites: true, allowBooking: true },
        fetchImpl: (async () => new Response(JSON.stringify({ message: 'Unauthorized' }), { status: 401, headers: { 'content-type': 'application/json' } })) as typeof fetch,
      });
      for (const input of inputsFor(entry.name)) {
        const result = await gateway.callTool(entry.name, input, context('grant-token-for-tests'));
        expect(result.isError, `${entry.name} ${JSON.stringify(input)}`).toBe(true);
        // A host recognises a withdrawn grant by this text; no tool may turn it into its own message.
        expect(result.content[0]?.text, `${entry.name} ${JSON.stringify(input)}`).toMatch(/^e-conomic API request failed with HTTP 401(?!\d)/);
      }
    }
  });

  it('passes a 401 on as e-conomic\'s own error also when it comes on a later request of a tool', async () => {
    for (const entry of economicToolCatalog) {
      if (entry.name === 'upsert_account') continue;
      for (const input of inputsFor(entry.name)) {
        for (let answered = 1; answered <= 6; answered++) {
          let sent = 0;
          let refused = false;
          const gateway = createEconomicGateway({
            appSecretToken: 'app-secret-for-tests',
            policy: { enableWrites: true, allowBooking: true },
            fetchImpl: (async (url: string | URL | Request, init?: RequestInit) => {
              sent++;
              if (sent <= answered) return upstreamResponse(new Request(url, init));
              refused = true;
              return new Response(JSON.stringify({ message: 'Unauthorized' }), { status: 401, headers: { 'content-type': 'application/json' } });
            }) as typeof fetch,
          });
          const result = await gateway.callTool(entry.name, input, context('grant-token-for-tests'));
          if (!refused) continue;
          expect(result.isError, `${entry.name} after ${answered}`).toBe(true);
          expect(result.content[0]?.text, `${entry.name} ${JSON.stringify(input)} after ${answered}`).toMatch(/^e-conomic API request failed with HTTP 401(?!\d)/);
        }
      }
    }
  });

  it('answers a missing customer of a draft invoice with its own message (404)', async () => {
    const gateway = createEconomicGateway({
      appSecretToken: 'app-secret-for-tests',
      policy: { enableWrites: true },
      fetchImpl: (async () => new Response(JSON.stringify({ message: 'Not found' }), { status: 404, headers: { 'content-type': 'application/json' } })) as typeof fetch,
    });
    const result = await gateway.callTool('create_draft_invoice', { customerNumber: 1, lines: [{ productNumber: 'P1', quantity: 1 }] }, context('grant-token-for-tests'));
    expect(result.content[0]?.text).toBe('Customer 1 could not be read from e-conomic.');
  });

  it('makes only requests its catalog entry declares, for every tool', async () => {
    for (const entry of economicToolCatalog) {
      const declared = entry.upstream.map(operation => ({ method: operation.method, pattern: pattern(operation.path) }));
      const requests: Request[] = [];
      const gateway = createEconomicGateway({
        appSecretToken: 'app-secret-for-tests',
        policy: { enableWrites: true, allowBooking: true },
        fetchImpl: (async (input: string | URL | Request, init?: RequestInit) => {
          const request = new Request(input, init);
          requests.push(request);
          return upstreamResponse(request);
        }) as typeof fetch,
      });
      for (const input of inputsFor(entry.name)) {
        const result = await gateway.callTool(entry.name, input, context('grant-token-for-tests'));
        if (entry.name === 'upsert_account') {
          // The chart of accounts is behind the fixed fence: refused before the write is sent.
          expect(result.isError, JSON.stringify(input)).toBe(true);
          expect(result.content[0]?.text).toContain('gateway fence');
          continue;
        }
        expect(result.isError, `${entry.name} ${JSON.stringify(input)}: ${result.content[0]?.text}`).toBeUndefined();
        expectDataInText(result, `${entry.name} ${JSON.stringify(input)}`);
      }
      // upsert_account is refused before any request (the chart of accounts is behind the fence).
      if (entry.name !== 'upsert_account') expect(requests.length, entry.name).toBeGreaterThan(0);
      for (const request of requests) {
        const url = new URL(request.url);
        const ok = declared.some(operation => operation.method === request.method && operation.pattern.test(url.pathname));
        expect(ok, `${entry.name} made undeclared ${request.method} ${url.pathname}`).toBe(true);
      }
    }
  });
});

describe('catalog export', () => {
  it('lists every tool once with its upstream requests, frozen', () => {
    expect(economicToolCatalog.map(tool => tool.name)).toEqual(economicGatewayTools.map(tool => tool.name));
    expect(Object.isFrozen(economicToolCatalog)).toBe(true);
    expect(Object.isFrozen(economicToolCatalog[0]!.upstream)).toBe(true);
    expect(Object.isFrozen(economicServiceCatalog.endpoints)).toBe(true);
    expect(() => {
      (catalogEntry('customer_overview').upstream as unknown[]).push({ access: 'read', method: 'GET', path: '/x' });
    }).toThrow();
    for (const tool of economicToolCatalog) {
      expect(tool.upstream.length, tool.name).toBeGreaterThan(0);
      const writes = tool.upstream.filter(operation => operation.access === 'write');
      if (tool.riskLevel === 'read') expect(writes, tool.name).toEqual([]);
      else expect(writes.length, tool.name).toBeGreaterThan(0);
      for (const operation of tool.upstream) {
        expect(operation.access).toBe(operation.method === 'GET' ? 'read' : 'write');
        expect(operation.path.startsWith('/'), operation.path).toBe(true);
      }
    }
    expect(catalogEntry('customer_overview').defaultRead).toEqual({ serviceId: 'customers', resource: 'Customers' });
    expect(catalogEntry('get_entity').defaultRead).toBeUndefined();
  });

  it('keeps booked entries out of every narrow read tool except accounting_entries', () => {
    for (const name of NARROW_READ_TOOLS.filter(tool => tool !== 'accounting_entries')) {
      expect(readTargets(name).some(target => target.serviceId === 'booked-entries')).toBe(false);
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
    process.env.ECONOMIC_ENABLE_BOOKING = 'true';
    // loadPolicy() would throw reading this file; the gateway must not read it.
    process.env.ECONOMIC_POLICY_PATH = '/nonexistent/economic-policy.json';

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

describe('per-call credential isolation', () => {
  it('does not keep one call’s token in the gateway instance for the next call', async () => {
    // Call 1 uses token A. Call 2 uses token B and gets an upstream error that
    // echoes A. Only a gateway that kept A after call 1 would redact it here,
    // so seeing A proves call 1's token stayed inside call 1.
    const tokenA = 'tenant-a-token-1234567';
    const tokenB = 'tenant-b-token-7654321';
    let calls = 0;
    const { gateway } = recordingGateway(() => {
      calls += 1;
      return calls === 1
        ? Response.json({ collection: [] })
        : new Response(`denied; last token seen ${tokenA}; this token ${tokenB}`, {
          status: 403,
          headers: { 'content-type': 'text/plain' },
        });
    });
    await gateway.callTool('customer_overview', {}, context(tokenA));
    const second = await gateway.callTool('customer_overview', {}, context(tokenB));
    expect(second.isError).toBe(true);
    expect(second.content[0]?.text).not.toContain(tokenB);
    expect(second.content[0]?.text).toContain(tokenA);
  });

  it('redacts the call’s token from a thrown non-HTTP error', async () => {
    const token = 'thrown-error-token-123456';
    const fetchImpl = vi.fn(async () => {
      throw new Error(`socket failed while sending ${token}`);
    });
    const gateway = createEconomicGateway({
      appSecretToken: 'app-secret-for-tests',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const result = await gateway.callTool('customer_overview', {}, context(token));
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('socket failed');
    expect(result.content[0]?.text).not.toContain(token);
  });

  it('treats a whitespace-only token as missing', async () => {
    expect(() => createEconomicGateway({ appSecretToken: '   ' })).toThrow(/appSecretToken is required/);
    expect(() => createEconomicGateway({ appSecretToken: 'app-secret-for-tests', agreementGrantToken: ' 	 ' })).toThrow();
    const { gateway, fetchImpl } = recordingGateway();
    const result = await gateway.callTool('customer_overview', {}, context('   '));
    expect(result.isError).toBe(true);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('refuses writes before any preparatory read when writes are off', async () => {
    const { gateway, fetchImpl } = recordingGateway(() => Response.json({ customerNumber: 1, layoutNumber: 1 }));
    for (const [name, input] of [
      ['upsert_customer', { customerNumber: 1, name: 'X' }],
      ['upsert_product', { productNumber: 'P1', name: 'X' }],
      ['create_draft_invoice', { customerNumber: 1, lines: [{ productNumber: 'P1', quantity: 1 }] }],
      ['upsert_account', { accountNumber: 1000, name: 'X' }],
    ] as Array<[string, GatewayJsonObject]>) {
      const result = await gateway.callTool(name, input, context('grant-token-for-tests'));
      expect(result.isError, name).toBe(true);
      expect(result.content[0]?.text).toContain('writes disabled');
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('get_entity self URL host', () => {
  it('refuses a self URL on another host, even with an API-shaped path', async () => {
    const { gateway, fetchImpl } = recordingGateway();
    for (const selfUrl of [
      'https://evil.example/customersapi/v3.1.0/Customers/1',
      'https://evil.example/customers/1',
      'https://restapi.e-conomic.com.evil.example/customers/1',
    ]) {
      expect(resolveEconomicReadTarget('get_entity', { selfUrl }).ok, selfUrl).toBe(false);
      const result = await gateway.callTool('get_entity', { selfUrl }, context('grant-token-for-tests'));
      expect(result.isError, selfUrl).toBe(true);
    }
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(resolveEconomicReadTarget('get_entity', { selfUrl: 'https://apis.e-conomic.com/customersapi/v3.1.0/Customers/1' }).ok).toBe(true);
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
    expect(summaryLine(list)).toBe('search_entities: 2 of 10 records from rest:customers. More pages are available.');
    expect(list.structuredContent).toMatchObject({ collection: [{ customerNumber: 1 }, { customerNumber: 2 }] });
    expectDataInText(list);

    const one = await gateway.callTool('customer_overview', { number: 1 }, context('grant-token-for-tests'));
    expect(summaryLine(one)).toBe('customer_overview: one record from customers:Customers.');
    expectDataInText(one);

    const contract = await createEconomicGateway({ contractMode: true }).callTool('invoice_overview', {});
    expect(summaryLine(contract)).toBe('invoice_overview: 2 records from rest:invoices/booked.');
    expectDataInText(contract);
  });

  it('puts the data in the text block too, as compact JSON after the summary line', async () => {
    const { gateway } = recordingGateway(() => Response.json({ collection: [{ customerNumber: 1, name: 'Kunde Et ApS' }], pagination: { results: 1 } }));
    const result = await gateway.callTool('search_entities', {}, context('grant-token-for-tests'));
    expect(result.content).toHaveLength(1);
    const [summary, json, ...rest] = result.content[0]!.text.split('\n\n');
    expect(summary).toBe('search_entities: 1 record from rest:customers.');
    expect(rest).toEqual([]);
    expect(json).toBe(JSON.stringify(result.structuredContent));
    expect(json).not.toContain('\n');
    expect(result.content[0]!.text).toContain('Kunde Et ApS');
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
    expectDataInText(result);
    expect(result.content[0]?.text).toContain('"name":"Testfirma ApS"');
    expect(result.content[0]?.text).toContain('11223344');
    const text = JSON.stringify(result);
    for (const leaked of ['Some Bank', '1234567890', 'Granting User', 'granting.user@example.test', 'granting-login', 'public-app-token', 'firma@example.test']) {
      expect(text).not.toContain(leaked);
    }

    const contract = await createEconomicGateway({ contractMode: true }).callTool('company_context', {});
    expectDataInText(contract);
    expect(JSON.stringify(contract)).not.toMatch(/Demo Bank|user@example\.test|demo-public-token/);
  });
});
