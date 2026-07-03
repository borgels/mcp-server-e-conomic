import { EconomicClient, type EconomicClientOptions, type QueryValue } from './economic/client.js';
import { callEndpoint } from './economic/endpoints.js';
import { checkPolicy, loadPolicy, type EconomicPolicy } from './economic/policy.js';
import { EconomicHttpError } from './errors.js';
import {
  economicGatewayContractEntity,
  economicGatewayContractFixture,
} from './economic/gateway-fixtures.js';

export type GatewayRiskLevel = 'read' | 'write' | 'destructive';
export type GatewayJsonValue = string | number | boolean | null | GatewayJsonValue[] | { [key: string]: GatewayJsonValue };
export type GatewayJsonObject = { [key: string]: GatewayJsonValue };

export interface GatewayToolDefinition {
  name: string;
  title: string;
  description: string;
  riskLevel: GatewayRiskLevel;
  enabledByDefault: boolean;
  inputSchema: GatewayJsonObject;
}

export interface GatewayToolResult {
  content: Array<{ type: 'text'; text: string }>;
  structuredContent?: GatewayJsonValue;
  isError?: boolean;
}

export interface EconomicGatewayOptions extends EconomicClientOptions {
  contractMode?: boolean;
  /**
   * Allow the write-risk gateway tools to execute. A hosting control plane that
   * embeds the gateway and applies its own write governance (scopes, approvals,
   * audit) passes `true` to opt in, instead of relying on the
   * ECONOMIC_ENABLE_WRITES environment flag used by the standalone server. The
   * rest of the write policy (denied paths, max amount) still applies on top.
   */
  enableWrites?: boolean;
}

const emptyInput = {
  type: 'object',
  properties: {},
  additionalProperties: false,
} satisfies GatewayJsonObject;

const createDraftInvoiceInput = {
  type: 'object',
  required: ['customerNumber', 'lines'],
  properties: {
    customerNumber: { type: 'number', description: 'e-conomic customer number the draft is for.' },
    lines: {
      type: 'array',
      minItems: 1,
      description: 'Invoice lines. e-conomic requires a product reference on each line.',
      items: {
        type: 'object',
        required: ['productNumber', 'quantity'],
        properties: {
          productNumber: { type: ['string', 'number'], description: 'e-conomic product number.' },
          description: { type: 'string', description: 'Line text. Defaults to the product name.' },
          quantity: { type: 'number' },
          unitNetPrice: { type: 'number', description: 'Net unit price. Defaults to the product sales price when omitted.' },
        },
        additionalProperties: false,
      },
    },
    date: { type: 'string', description: 'Invoice date (ISO 8601 date). Defaults to today.' },
    currency: { type: 'string', description: 'Currency code. Defaults to the customer currency.' },
    paymentTermsNumber: { type: 'number', description: 'Defaults to the customer payment terms.' },
    layoutNumber: { type: 'number', description: 'Defaults to the first available layout.' },
    recipientName: { type: 'string', description: 'Defaults to the customer name.' },
    vatZoneNumber: { type: 'number', description: 'Defaults to the customer VAT zone.' },
    reference: { type: 'string', description: 'Optional free-text reference stored on the draft.' },
    notes: {
      type: 'object',
      properties: {
        heading: { type: 'string' },
        textLine1: { type: 'string' },
      },
      additionalProperties: false,
    },
    idempotencyKey: { type: 'string', description: 'Optional idempotency key forwarded to e-conomic.' },
  },
  additionalProperties: false,
} satisfies GatewayJsonObject;

const upsertCustomerInput = {
  type: 'object',
  properties: {
    customerNumber: {
      type: 'number',
      description: 'Existing customer number. When set, that customer is updated (read-merge-write); when omitted, a new customer is created.',
    },
    name: { type: 'string', description: 'Customer name. Required when creating.' },
    currency: { type: 'string', description: 'Currency code, e.g. DKK. Required when creating.' },
    customerGroupNumber: { type: 'number', description: 'Customer group number. Required when creating.' },
    paymentTermsNumber: { type: 'number', description: 'Payment terms number. Required when creating.' },
    vatZoneNumber: { type: 'number', description: 'VAT zone number. Required when creating.' },
    email: { type: 'string' },
    address: { type: 'string' },
    zip: { type: 'string' },
    city: { type: 'string' },
    country: { type: 'string' },
    corporateIdentificationNumber: { type: 'string', description: 'Company registration number (e.g. CVR).' },
    ean: { type: 'string', description: 'EAN/GLN location number for electronic invoicing.' },
    telephoneAndFaxNumber: { type: 'string' },
  },
  additionalProperties: false,
} satisfies GatewayJsonObject;

const upsertProductInput = {
  type: 'object',
  required: ['productNumber'],
  properties: {
    productNumber: {
      type: ['string', 'number'],
      description: 'Product number (the product key). Updates the product when it exists, creates it otherwise.',
    },
    name: { type: 'string', description: 'Product name. Required when creating.' },
    productGroupNumber: { type: 'number', description: 'Product group number. Required when creating.' },
    salesPrice: { type: 'number', description: 'Net sales price.' },
    costPrice: { type: 'number' },
    recommendedPrice: { type: 'number' },
    description: { type: 'string' },
    unitNumber: { type: 'number', description: 'Unit number, see the units resource.' },
    barred: { type: 'boolean', description: 'Bar the product from being used on new documents.' },
  },
  additionalProperties: false,
} satisfies GatewayJsonObject;

// Projects add-on (projectsapi, OpenAPI). e-conomic upserts a project via the
// collection: POST /Projects creates, PUT /Projects (full object incl. its
// number) updates - item-level PUT returns 405. responsibleEmployee references
// a Projects-add-on employee, not a REST employee. additionalFields is a
// passthrough for less-common attributes so the tool covers the resource
// without enumerating every field.
const upsertProjectInput = {
  type: 'object',
  properties: {
    projectNumber: {
      type: 'number',
      description: 'Existing project number. When set, that project is updated (read-merge-write); when omitted, a new project is created.',
    },
    name: { type: 'string', description: 'Project name. Required when creating.' },
    projectGroupNumber: { type: 'number', description: 'Project group number. Required when creating.' },
    customerNumber: { type: 'number', description: 'Customer number the project is for. Required when creating.' },
    responsibleEmployeeNumber: { type: 'number', description: 'Responsible Projects employee number. Required when creating.' },
    description: { type: 'string' },
    barred: { type: 'boolean', description: 'Bar the project from new registrations.' },
    additionalFields: {
      type: 'object',
      description: 'Optional additional Projects API fields to set on the project (passthrough).',
      additionalProperties: true,
    },
  },
  additionalProperties: false,
} satisfies GatewayJsonObject;

const createTimeEntryInput = {
  type: 'object',
  required: ['projectNumber', 'activityNumber', 'employeeNumber', 'date', 'hours'],
  properties: {
    projectNumber: { type: 'number', description: 'Project number the time is registered on.' },
    activityNumber: { type: 'number', description: 'Activity number the time is registered against.' },
    employeeNumber: { type: 'number', description: 'Projects employee number the time belongs to.' },
    date: { type: 'string', description: 'Registration date (ISO 8601 date).' },
    hours: { type: 'number', description: 'Number of hours to register.' },
    description: { type: 'string', description: 'Optional note stored on the registration.' },
    additionalFields: {
      type: 'object',
      description: 'Optional additional TimeEntries API fields (passthrough).',
      additionalProperties: true,
    },
  },
  additionalProperties: false,
} satisfies GatewayJsonObject;

// Suppliers are classic REST master data (no OpenAPI supplier record), so the
// upsert mirrors the customer flow: create via POST /suppliers, update by
// supplierNumber via read-merge-write PUT /suppliers/{number}.
const upsertSupplierInput = {
  type: 'object',
  properties: {
    supplierNumber: {
      type: 'number',
      description: 'Existing supplier number. When set, that supplier is updated (read-merge-write); when omitted, a new supplier is created.',
    },
    name: { type: 'string', description: 'Supplier name. Required when creating.' },
    currency: { type: 'string', description: 'Currency code, e.g. DKK. Required when creating.' },
    supplierGroupNumber: { type: 'number', description: 'Supplier group number. Required when creating.' },
    paymentTermsNumber: { type: 'number', description: 'Payment terms number. Required when creating.' },
    vatZoneNumber: { type: 'number', description: 'VAT zone number. Required when creating.' },
    email: { type: 'string' },
    address: { type: 'string' },
    zip: { type: 'string' },
    city: { type: 'string' },
    country: { type: 'string' },
    corporateIdentificationNumber: { type: 'string', description: 'Company registration number (e.g. CVR).' },
    additionalFields: {
      type: 'object',
      description: 'Optional additional supplier fields to set (passthrough).',
      additionalProperties: true,
    },
  },
  additionalProperties: false,
} satisfies GatewayJsonObject;

// Projects add-on employees upsert via the collection like projects: create
// POST /Employees, update collection PUT /Employees (read-merge-write).
const upsertEmployeeInput = {
  type: 'object',
  properties: {
    employeeNumber: {
      type: 'number',
      description: 'Existing employee number. When set, that employee is updated (read-merge-write); when omitted, a new employee is created.',
    },
    name: { type: 'string', description: 'Employee name. Required when creating.' },
    barred: { type: 'boolean', description: 'Bar the employee from new registrations.' },
    additionalFields: {
      type: 'object',
      description: 'Optional additional Projects Employee fields (passthrough).',
      additionalProperties: true,
    },
  },
  additionalProperties: false,
} satisfies GatewayJsonObject;

const readEndpointInput = {
  type: 'object',
  properties: {
    serviceId: { type: 'string', description: 'e-conomic service id. Defaults to the tool-specific service.' },
    resource: { type: 'string', description: 'Resource path within the selected service.' },
    number: { type: ['string', 'number'], description: 'Optional entity number/id for a direct lookup.' },
    paged: { type: 'boolean', description: 'Use the /paged collection endpoint when no number is supplied.' },
    query: {
      type: 'object',
      description: 'Optional query parameters passed to e-conomic.',
      additionalProperties: true,
    },
  },
  additionalProperties: false,
} satisfies GatewayJsonObject;

export const economicGatewayTools: GatewayToolDefinition[] = [
  {
    name: 'check_connection',
    title: 'Check e-conomic connection',
    description: 'Verify that the configured e-conomic credentials can access the API.',
    riskLevel: 'read',
    enabledByDefault: true,
    inputSchema: emptyInput,
  },
  {
    name: 'company_context',
    title: 'Get e-conomic company context',
    description: 'Read the e-conomic REST root context and company/resource links.',
    riskLevel: 'read',
    enabledByDefault: true,
    inputSchema: emptyInput,
  },
  {
    name: 'search_entities',
    title: 'Search e-conomic entities',
    description: 'List customers, suppliers, products, accounts, projects, documents, or entries.',
    riskLevel: 'read',
    enabledByDefault: true,
    inputSchema: readEndpointInput,
  },
  {
    name: 'get_entity',
    title: 'Get e-conomic entity',
    description: 'Fetch one e-conomic entity by service/resource/number or by a safe e-conomic self URL.',
    riskLevel: 'read',
    enabledByDefault: true,
    inputSchema: {
      type: 'object',
      properties: {
        serviceId: { type: 'string' },
        resource: { type: 'string' },
        number: { type: ['string', 'number'] },
        selfUrl: { type: 'string' },
        query: { type: 'object', additionalProperties: true },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'customer_overview',
    title: 'Get e-conomic customer overview',
    description: 'Read customer master data and related customer resources.',
    riskLevel: 'read',
    enabledByDefault: true,
    inputSchema: readEndpointInput,
  },
  {
    name: 'supplier_overview',
    title: 'Get e-conomic supplier overview',
    description: 'Read supplier groups or supplier contact data.',
    riskLevel: 'read',
    enabledByDefault: true,
    inputSchema: readEndpointInput,
  },
  {
    name: 'product_overview',
    title: 'Get e-conomic product overview',
    description: 'Read products, product groups, price groups, and sales price data.',
    riskLevel: 'read',
    enabledByDefault: true,
    inputSchema: readEndpointInput,
  },
  {
    name: 'report_data',
    title: 'Get e-conomic report data',
    description: 'Read accounts, booked entries, budgets, and accounting-year resources for reporting.',
    riskLevel: 'read',
    enabledByDefault: true,
    inputSchema: readEndpointInput,
  },
  {
    name: 'invoice_overview',
    title: 'Get e-conomic invoice overview',
    description:
      'List booked invoices (default) or an invoice collection (booked, unpaid, overdue, paid, sent, drafts) for revenue and receivables reporting. Supports query paging (skippages, pagesize) and filters.',
    riskLevel: 'read',
    enabledByDefault: true,
    inputSchema: readEndpointInput,
  },
  {
    name: 'project_overview',
    title: 'Get e-conomic project overview',
    description:
      'Read the Projects add-on: projects (default), project groups, cost types, activities, employees, or time entries. Set resource to select (Projects, ProjectGroups, CostTypes, Activities, Employees, TimeEntries).',
    riskLevel: 'read',
    enabledByDefault: true,
    inputSchema: readEndpointInput,
  },
  {
    name: 'accounting_entries',
    title: 'Get e-conomic accounting entries',
    description:
      'Read booked accounting entries (default) or, via serviceId/resource, journal draft entries. Used for ledger, supplier-invoice, and reconciliation reads. Supports paging and filters.',
    riskLevel: 'read',
    enabledByDefault: true,
    inputSchema: readEndpointInput,
  },
  {
    name: 'create_draft_invoice',
    title: 'Create e-conomic draft invoice',
    description:
      'Create a draft (unbooked, unsent) sales invoice for a customer. Drafts can be reviewed or deleted and are not booked or sent; this does not post anything to the customer. Write — disabled by default; enable via the gateway’s enableWrites option or the ECONOMIC_ENABLE_WRITES env flag.',
    riskLevel: 'write',
    enabledByDefault: false,
    inputSchema: createDraftInvoiceInput,
  },
  {
    name: 'upsert_customer',
    title: 'Create or update e-conomic customer',
    description:
      'Create a customer, or update an existing one by customerNumber (reads the current customer and merges the provided fields). Write — disabled by default; enable via the gateway’s enableWrites option or the ECONOMIC_ENABLE_WRITES env flag.',
    riskLevel: 'write',
    enabledByDefault: false,
    inputSchema: upsertCustomerInput,
  },
  {
    name: 'upsert_product',
    title: 'Create or update e-conomic product',
    description:
      'Create a product, or update it when the productNumber already exists (reads the current product and merges the provided fields). Write — disabled by default; enable via the gateway’s enableWrites option or the ECONOMIC_ENABLE_WRITES env flag.',
    riskLevel: 'write',
    enabledByDefault: false,
    inputSchema: upsertProductInput,
  },
  {
    name: 'upsert_project',
    title: 'Create or update e-conomic project',
    description:
      'Create a project in the Projects add-on, or update an existing one by projectNumber (reads the current project and merges the provided fields; upserts via the collection PUT). Write — disabled by default; enable via the gateway’s enableWrites option or the ECONOMIC_ENABLE_WRITES env flag.',
    riskLevel: 'write',
    enabledByDefault: false,
    inputSchema: upsertProjectInput,
  },
  {
    name: 'create_time_entry',
    title: 'Register e-conomic project time',
    description:
      'Register a project time entry (hours on a project + activity for an employee, on a date). Create only; deletion is a separate operation. Write — disabled by default; enable via the gateway’s enableWrites option or the ECONOMIC_ENABLE_WRITES env flag.',
    riskLevel: 'write',
    enabledByDefault: false,
    inputSchema: createTimeEntryInput,
  },
  {
    name: 'upsert_supplier',
    title: 'Create or update e-conomic supplier',
    description:
      'Create a supplier, or update an existing one by supplierNumber (reads the current supplier and merges the provided fields). Write — disabled by default; enable via the gateway’s enableWrites option or the ECONOMIC_ENABLE_WRITES env flag.',
    riskLevel: 'write',
    enabledByDefault: false,
    inputSchema: upsertSupplierInput,
  },
  {
    name: 'upsert_employee',
    title: 'Create or update e-conomic project employee',
    description:
      'Create a Projects add-on employee, or update an existing one by employeeNumber (collection upsert, read-merge-write). Write — disabled by default; enable via the gateway’s enableWrites option or the ECONOMIC_ENABLE_WRITES env flag.',
    riskLevel: 'write',
    enabledByDefault: false,
    inputSchema: upsertEmployeeInput,
  },
];

export function createEconomicGateway(options: EconomicGatewayOptions = {}) {
  const client = new EconomicClient(options);
  // Writes are permitted when the embedder opts in via `enableWrites` or the
  // standalone ECONOMIC_ENABLE_WRITES env flag; the rest of the write policy
  // (allowed methods, denied paths, max amount) still applies on top.
  const writePolicy: EconomicPolicy = options.enableWrites
    ? { ...loadPolicy(), writesEnabled: true }
    : loadPolicy();

  return {
    tools: economicGatewayTools,
    async callTool(toolName: string, input: GatewayJsonObject = {}): Promise<GatewayToolResult> {
      if (options.contractMode) {
        return contractToolResult(toolName, input);
      }

      switch (toolName) {
        case 'check_connection':
        case 'company_context':
          return jsonResult('e-conomic connection is available.', await client.rest('/'));

        case 'search_entities':
          return readEndpointResult(client, input, {
            serviceId: 'rest',
            resource: 'customers',
          });

        case 'get_entity':
          return getEntity(client, input);

        case 'customer_overview':
          return readEndpointResult(client, input, {
            serviceId: 'customers',
            resource: 'Customers',
          });

        case 'supplier_overview':
          return readEndpointResult(client, input, {
            serviceId: 'rest',
            resource: 'suppliers',
          });

        case 'product_overview':
          return readEndpointResult(client, input, {
            serviceId: 'products',
            resource: 'products',
          });

        case 'report_data':
          return readEndpointResult(client, input, {
            serviceId: 'accounts',
            resource: 'Accounts',
          });

        case 'invoice_overview':
          return readRestList(client, input, {
            serviceId: 'rest',
            resource: 'invoices/booked',
          });

        case 'project_overview':
          return readEndpointResult(client, input, {
            serviceId: 'projects',
            resource: 'Projects',
          });

        case 'accounting_entries':
          return readEndpointResult(client, input, {
            serviceId: 'booked-entries',
            resource: 'booked-entries',
          });

        case 'create_draft_invoice':
          return createDraftInvoice(client, input, writePolicy);

        case 'upsert_customer':
          return upsertCustomer(client, input, writePolicy);

        case 'upsert_product':
          return upsertProduct(client, input, writePolicy);

        case 'upsert_project':
          return upsertProject(client, input, writePolicy);

        case 'create_time_entry':
          return createTimeEntry(client, input, writePolicy);

        case 'upsert_supplier':
          return upsertSupplier(client, input, writePolicy);

        case 'upsert_employee':
          return upsertEmployee(client, input, writePolicy);

        default:
          return errorResult(`Unsupported e-conomic gateway tool: ${toolName}`);
      }
    },
  };
}

function contractToolResult(toolName: string, input: GatewayJsonObject): GatewayToolResult {
  if (toolName === 'get_entity') {
    const selfUrl = stringValue(input.selfUrl);
    if (!selfUrl && (!stringValue(input.serviceId) || stringOrNumberValue(input.number) === undefined)) {
      return errorResult('Provide either selfUrl or serviceId, resource, and number.');
    }

    return fixtureResult(economicGatewayContractEntity(input));
  }

  const fixture = economicGatewayContractFixture(toolName, input);
  if (!fixture) {
    return errorResult(`Unsupported e-conomic gateway tool: ${toolName}`);
  }

  return fixtureResult(fixture);
}

function fixtureResult(fixture: { text: string; structuredContent: unknown }): GatewayToolResult {
  return jsonResult(fixture.text, fixture.structuredContent);
}

async function getEntity(client: EconomicClient, input: GatewayJsonObject): Promise<GatewayToolResult> {
  const selfUrl = stringValue(input.selfUrl);
  if (selfUrl) {
    assertEconomicUrl(selfUrl);
    return jsonResult('Fetched e-conomic entity.', await client.request({
      url: selfUrl,
      query: queryValue(input.query),
    }));
  }

  const serviceId = stringValue(input.serviceId);
  const resource = stringValue(input.resource);
  const number = stringOrNumberValue(input.number);
  if (!serviceId || !resource || number === undefined) {
    return errorResult('Provide either selfUrl or serviceId, resource, and number.');
  }

  return jsonResult('Fetched e-conomic entity.', await callEndpoint(client, {
    serviceId,
    method: 'GET',
    pathTemplate: `/${resource}/{number}`,
    pathParams: { number },
    query: queryValue(input.query),
  }));
}

async function readEndpointResult(
  client: EconomicClient,
  input: GatewayJsonObject,
  defaults: { serviceId: string; resource: string },
): Promise<GatewayToolResult> {
  const serviceId = stringValue(input.serviceId) ?? defaults.serviceId;
  const resource = stringValue(input.resource) ?? defaults.resource;
  const number = stringOrNumberValue(input.number);
  const paged = input.paged === false ? false : true;
  const pathTemplate = number !== undefined ? `/${resource}/{number}` : paged ? `/${resource}/paged` : `/${resource}`;

  return jsonResult('Fetched e-conomic data.', await callEndpoint(client, {
    serviceId,
    method: 'GET',
    pathTemplate,
    pathParams: number === undefined ? undefined : { number },
    query: queryValue(input.query),
  }));
}

// REST sub-collections (e.g. /invoices/booked) page via query params, not a
// /paged path segment, so this reads the collection path directly with the
// caller's query (skippages, pagesize, filter), or one item by number.
async function readRestList(
  client: EconomicClient,
  input: GatewayJsonObject,
  defaults: { serviceId: string; resource: string },
): Promise<GatewayToolResult> {
  const serviceId = stringValue(input.serviceId) ?? defaults.serviceId;
  const resource = stringValue(input.resource) ?? defaults.resource;
  const number = stringOrNumberValue(input.number);
  const pathTemplate = number !== undefined ? `/${resource}/{number}` : `/${resource}`;

  return jsonResult('Fetched e-conomic data.', await callEndpoint(client, {
    serviceId,
    method: 'GET',
    pathTemplate,
    pathParams: number === undefined ? undefined : { number },
    query: queryValue(input.query),
  }));
}

interface DraftCustomer {
  name?: string;
  currency?: string;
  paymentTerms?: { paymentTermsNumber?: number };
  vatZone?: { vatZoneNumber?: number };
}

async function createDraftInvoice(
  client: EconomicClient,
  input: GatewayJsonObject,
  policy: EconomicPolicy,
): Promise<GatewayToolResult> {
  const customerNumber = numberValue(input.customerNumber);
  if (customerNumber === undefined) {
    return errorResult('create_draft_invoice requires a numeric customerNumber.');
  }

  const rawLines = Array.isArray(input.lines) ? input.lines : [];
  if (rawLines.length === 0) {
    return errorResult('create_draft_invoice requires at least one line.');
  }

  const lines: GatewayJsonObject[] = [];
  for (let index = 0; index < rawLines.length; index += 1) {
    const source = rawLines[index];
    const line = source && typeof source === 'object' && !Array.isArray(source) ? source : {};
    const productNumber = stringOrNumberValue(line.productNumber);
    const quantity = numberValue(line.quantity);
    if (productNumber === undefined) {
      return errorResult(`Line ${index + 1} requires a productNumber; e-conomic requires a product reference on each line.`);
    }
    if (quantity === undefined) {
      return errorResult(`Line ${index + 1} requires a numeric quantity.`);
    }

    const built: GatewayJsonObject = { lineNumber: index + 1, product: { productNumber }, quantity };
    const description = stringValue(line.description);
    if (description) {
      built.description = description;
    }
    const unitNetPrice = numberValue(line.unitNetPrice);
    if (unitNetPrice !== undefined) {
      built.unitNetPrice = unitNetPrice;
    }
    lines.push(built);
  }

  let customer: DraftCustomer = {};
  try {
    customer = (await client.rest(`/customers/${customerNumber}`)) as DraftCustomer;
  } catch {
    return errorResult(`Customer ${customerNumber} could not be read from e-conomic.`);
  }

  const currency = stringValue(input.currency) ?? customer.currency;
  const paymentTermsNumber = numberValue(input.paymentTermsNumber) ?? customer.paymentTerms?.paymentTermsNumber;
  const vatZoneNumber = numberValue(input.vatZoneNumber) ?? customer.vatZone?.vatZoneNumber;
  const recipientName = stringValue(input.recipientName) ?? customer.name;
  const layoutNumber = numberValue(input.layoutNumber) ?? (await firstLayoutNumber(client));
  const date = stringValue(input.date) ?? new Date().toISOString().slice(0, 10);

  if (!currency || paymentTermsNumber === undefined || vatZoneNumber === undefined || !recipientName || layoutNumber === undefined) {
    return errorResult(
      'Could not resolve required draft fields (currency, payment terms, VAT zone, recipient, layout) from the customer; provide them explicitly.',
    );
  }

  const body: GatewayJsonObject = {
    date,
    currency,
    paymentTerms: { paymentTermsNumber },
    customer: { customerNumber },
    recipient: { name: recipientName, vatZone: { vatZoneNumber } },
    layout: { layoutNumber },
    lines,
  };

  const notes = notesObject(input.notes);
  if (notes) {
    body.notes = notes;
  }
  const reference = stringValue(input.reference);
  if (reference) {
    body.references = { other: reference };
  }

  const denied = writePolicyDenial(policy, {
    capability: 'create_draft_invoice',
    method: 'POST',
    path: '/invoices/drafts',
    body,
  });
  if (denied) {
    return denied;
  }

  const created = await callEndpoint(client, {
    serviceId: 'rest',
    method: 'POST',
    pathTemplate: '/invoices/drafts',
    body,
    idempotencyKey: stringValue(input.idempotencyKey),
  });

  return jsonResult('Created e-conomic draft invoice.', created);
}

// Fields the caller may set on a customer; nested reference objects are built
// from their *Number inputs so the REST body shape stays correct.
const CUSTOMER_FLAT_FIELDS = [
  'name',
  'currency',
  'email',
  'address',
  'zip',
  'city',
  'country',
  'corporateIdentificationNumber',
  'ean',
  'telephoneAndFaxNumber',
] as const;

async function upsertCustomer(
  client: EconomicClient,
  input: GatewayJsonObject,
  policy: EconomicPolicy,
): Promise<GatewayToolResult> {
  const customerNumber = numberValue(input.customerNumber);
  const flat: GatewayJsonObject = {};
  for (const field of CUSTOMER_FLAT_FIELDS) {
    const value = stringValue(input[field]);
    if (value !== undefined) {
      flat[field] = value;
    }
  }
  const customerGroupNumber = numberValue(input.customerGroupNumber);
  const paymentTermsNumber = numberValue(input.paymentTermsNumber);
  const vatZoneNumber = numberValue(input.vatZoneNumber);

  if (customerNumber === undefined) {
    if (
      !flat.name
      || !flat.currency
      || customerGroupNumber === undefined
      || paymentTermsNumber === undefined
      || vatZoneNumber === undefined
    ) {
      return errorResult(
        'Creating a customer requires name, currency, customerGroupNumber, paymentTermsNumber, and vatZoneNumber.',
      );
    }

    const body: GatewayJsonObject = {
      ...flat,
      customerGroup: { customerGroupNumber },
      paymentTerms: { paymentTermsNumber },
      vatZone: { vatZoneNumber },
    };

    const denied = writePolicyDenial(policy, {
      capability: 'upsert_customer',
      method: 'POST',
      path: '/customers',
      body,
    });
    if (denied) {
      return denied;
    }

    return jsonResult('Created e-conomic customer.', await callEndpoint(client, {
      serviceId: 'rest',
      method: 'POST',
      pathTemplate: '/customers',
      body,
    }));
  }

  // Update: the REST API replaces the full object on PUT, so read the current
  // customer and merge only the provided fields into it.
  let existing: GatewayJsonObject;
  try {
    existing = (await client.rest(`/customers/${customerNumber}`)) as GatewayJsonObject;
  } catch (error) {
    if (error instanceof EconomicHttpError && error.status === 404) {
      return errorResult(`Customer ${customerNumber} does not exist; omit customerNumber to create a new customer.`);
    }
    throw error;
  }

  const body: GatewayJsonObject = { ...existing, ...flat };
  if (customerGroupNumber !== undefined) {
    body.customerGroup = { customerGroupNumber };
  }
  if (paymentTermsNumber !== undefined) {
    body.paymentTerms = { paymentTermsNumber };
  }
  if (vatZoneNumber !== undefined) {
    body.vatZone = { vatZoneNumber };
  }

  const denied = writePolicyDenial(policy, {
    capability: 'upsert_customer',
    method: 'PUT',
    path: `/customers/${customerNumber}`,
    body,
  });
  if (denied) {
    return denied;
  }

  return jsonResult('Updated e-conomic customer.', await callEndpoint(client, {
    serviceId: 'rest',
    method: 'PUT',
    pathTemplate: '/customers/{number}',
    pathParams: { number: customerNumber },
    body,
  }));
}

async function upsertProduct(
  client: EconomicClient,
  input: GatewayJsonObject,
  policy: EconomicPolicy,
): Promise<GatewayToolResult> {
  const productNumber = stringOrNumberValue(input.productNumber);
  if (productNumber === undefined) {
    return errorResult('upsert_product requires a productNumber.');
  }

  const flat: GatewayJsonObject = {};
  const name = stringValue(input.name);
  if (name) {
    flat.name = name;
  }
  const description = stringValue(input.description);
  if (description) {
    flat.description = description;
  }
  for (const field of ['salesPrice', 'costPrice', 'recommendedPrice'] as const) {
    const value = numberValue(input[field]);
    if (value !== undefined) {
      flat[field] = value;
    }
  }
  if (typeof input.barred === 'boolean') {
    flat.barred = input.barred;
  }
  const productGroupNumber = numberValue(input.productGroupNumber);
  const unitNumber = numberValue(input.unitNumber);

  // The product number is its key, so existence decides create vs update.
  let existing: GatewayJsonObject | undefined;
  try {
    existing = (await client.rest(`/products/${encodeURIComponent(String(productNumber))}`)) as GatewayJsonObject;
  } catch (error) {
    if (!(error instanceof EconomicHttpError) || error.status !== 404) {
      throw error;
    }
  }

  if (!existing) {
    if (!flat.name || productGroupNumber === undefined) {
      return errorResult('Creating a product requires name and productGroupNumber.');
    }

    const body: GatewayJsonObject = {
      ...flat,
      productNumber: String(productNumber),
      productGroup: { productGroupNumber },
    };
    if (unitNumber !== undefined) {
      body.unit = { unitNumber };
    }

    const denied = writePolicyDenial(policy, {
      capability: 'upsert_product',
      method: 'POST',
      path: '/products',
      body,
    });
    if (denied) {
      return denied;
    }

    return jsonResult('Created e-conomic product.', await callEndpoint(client, {
      serviceId: 'rest',
      method: 'POST',
      pathTemplate: '/products',
      body,
    }));
  }

  const body: GatewayJsonObject = { ...existing, ...flat };
  if (productGroupNumber !== undefined) {
    body.productGroup = { productGroupNumber };
  }
  if (unitNumber !== undefined) {
    body.unit = { unitNumber };
  }

  const denied = writePolicyDenial(policy, {
    capability: 'upsert_product',
    method: 'PUT',
    path: `/products/${productNumber}`,
    body,
  });
  if (denied) {
    return denied;
  }

  return jsonResult('Updated e-conomic product.', await callEndpoint(client, {
    serviceId: 'rest',
    method: 'PUT',
    pathTemplate: '/products/{number}',
    pathParams: { number: productNumber },
    body,
  }));
}

const SUPPLIER_FLAT_FIELDS = [
  'name',
  'currency',
  'email',
  'address',
  'zip',
  'city',
  'country',
  'corporateIdentificationNumber',
] as const;

// Suppliers mirror customers on the classic REST surface: create via POST, full-
// object update via item PUT (read-merge-write).
async function upsertSupplier(
  client: EconomicClient,
  input: GatewayJsonObject,
  policy: EconomicPolicy,
): Promise<GatewayToolResult> {
  const supplierNumber = numberValue(input.supplierNumber);
  const flat: GatewayJsonObject = {};
  for (const field of SUPPLIER_FLAT_FIELDS) {
    const value = stringValue(input[field]);
    if (value !== undefined) {
      flat[field] = value;
    }
  }
  const additional = objectValue(input.additionalFields) ?? {};
  const supplierGroupNumber = numberValue(input.supplierGroupNumber);
  const paymentTermsNumber = numberValue(input.paymentTermsNumber);
  const vatZoneNumber = numberValue(input.vatZoneNumber);

  const applyRefs = (body: GatewayJsonObject): void => {
    if (supplierGroupNumber !== undefined) {
      body.supplierGroup = { supplierGroupNumber };
    }
    if (paymentTermsNumber !== undefined) {
      body.paymentTerms = { paymentTermsNumber };
    }
    if (vatZoneNumber !== undefined) {
      body.vatZone = { vatZoneNumber };
    }
  };

  if (supplierNumber === undefined) {
    if (!flat.name || !flat.currency || supplierGroupNumber === undefined || paymentTermsNumber === undefined || vatZoneNumber === undefined) {
      return errorResult(
        'Creating a supplier requires name, currency, supplierGroupNumber, paymentTermsNumber, and vatZoneNumber.',
      );
    }

    const body: GatewayJsonObject = { ...additional, ...flat };
    applyRefs(body);

    const denied = writePolicyDenial(policy, { capability: 'upsert_supplier', method: 'POST', path: '/suppliers', body });
    if (denied) {
      return denied;
    }

    return jsonResult('Created e-conomic supplier.', await callEndpoint(client, {
      serviceId: 'rest',
      method: 'POST',
      pathTemplate: '/suppliers',
      body,
    }));
  }

  let existing: GatewayJsonObject;
  try {
    existing = (await client.rest(`/suppliers/${supplierNumber}`)) as GatewayJsonObject;
  } catch (error) {
    if (error instanceof EconomicHttpError && error.status === 404) {
      return errorResult(`Supplier ${supplierNumber} does not exist; omit supplierNumber to create a new supplier.`);
    }
    throw error;
  }

  const body: GatewayJsonObject = { ...existing, ...additional, ...flat };
  applyRefs(body);

  const denied = writePolicyDenial(policy, {
    capability: 'upsert_supplier',
    method: 'PUT',
    path: `/suppliers/${supplierNumber}`,
    body,
  });
  if (denied) {
    return denied;
  }

  return jsonResult('Updated e-conomic supplier.', await callEndpoint(client, {
    serviceId: 'rest',
    method: 'PUT',
    pathTemplate: '/suppliers/{number}',
    pathParams: { number: supplierNumber },
    body,
  }));
}

// Projects add-on employees upsert via the collection like projects.
async function upsertEmployee(
  client: EconomicClient,
  input: GatewayJsonObject,
  policy: EconomicPolicy,
): Promise<GatewayToolResult> {
  const employeeNumber = numberValue(input.employeeNumber);
  const flat: GatewayJsonObject = {};
  const name = stringValue(input.name);
  if (name) {
    flat.name = name;
  }
  if (typeof input.barred === 'boolean') {
    flat.barred = input.barred;
  }
  const additional = objectValue(input.additionalFields) ?? {};

  if (employeeNumber === undefined) {
    if (!flat.name) {
      return errorResult('Creating an employee requires a name.');
    }

    const body: GatewayJsonObject = { ...additional, ...flat };
    const denied = writePolicyDenial(policy, {
      capability: 'upsert_employee',
      serviceId: 'projects',
      method: 'POST',
      path: '/Employees',
      body,
    });
    if (denied) {
      return denied;
    }

    return jsonResult('Created e-conomic project employee.', await callEndpoint(client, {
      serviceId: 'projects',
      method: 'POST',
      pathTemplate: '/Employees',
      body,
    }));
  }

  let existing: GatewayJsonObject;
  try {
    existing = (await callEndpoint(client, {
      serviceId: 'projects',
      method: 'GET',
      pathTemplate: '/Employees/{number}',
      pathParams: { number: employeeNumber },
    })) as GatewayJsonObject;
  } catch (error) {
    if (error instanceof EconomicHttpError && error.status === 404) {
      return errorResult(`Employee ${employeeNumber} does not exist; omit employeeNumber to create a new employee.`);
    }
    throw error;
  }

  const body: GatewayJsonObject = { ...existing, ...additional, ...flat, employeeNumber };
  const denied = writePolicyDenial(policy, {
    capability: 'upsert_employee',
    serviceId: 'projects',
    method: 'PUT',
    path: '/Employees',
    body,
  });
  if (denied) {
    return denied;
  }

  return jsonResult('Updated e-conomic project employee.', await callEndpoint(client, {
    serviceId: 'projects',
    method: 'PUT',
    pathTemplate: '/Employees',
    body,
  }));
}

function writePolicyDenial(
  policy: EconomicPolicy,
  input: { capability: string; method: 'POST' | 'PUT'; path: string; body?: unknown; serviceId?: string },
): GatewayToolResult | undefined {
  const decision = checkPolicy({
    capability: input.capability,
    serviceId: input.serviceId ?? 'rest',
    method: input.method,
    path: input.path,
    body: input.body,
  }, policy);

  return decision.allowed ? undefined : errorResult(`Write blocked by policy: ${decision.reason}`);
}

// Projects add-on upsert: create is POST /Projects, update is the collection
// PUT /Projects with the full object (read-merge-write preserves objectVersion
// and fields the caller did not touch). Item-level PUT returns 405, so both
// paths go through the collection.
async function upsertProject(
  client: EconomicClient,
  input: GatewayJsonObject,
  policy: EconomicPolicy,
): Promise<GatewayToolResult> {
  const projectNumber = numberValue(input.projectNumber);
  const flat: GatewayJsonObject = {};
  const name = stringValue(input.name);
  if (name) {
    flat.name = name;
  }
  const description = stringValue(input.description);
  if (description) {
    flat.description = description;
  }
  if (typeof input.barred === 'boolean') {
    flat.barred = input.barred;
  }
  const additional = objectValue(input.additionalFields) ?? {};
  const projectGroupNumber = numberValue(input.projectGroupNumber);
  const customerNumber = numberValue(input.customerNumber);
  const responsibleEmployeeNumber = numberValue(input.responsibleEmployeeNumber);

  const applyRefs = (body: GatewayJsonObject): void => {
    if (projectGroupNumber !== undefined) {
      body.projectGroup = { projectGroupNumber };
    }
    if (customerNumber !== undefined) {
      body.customer = { customerNumber };
    }
    if (responsibleEmployeeNumber !== undefined) {
      body.responsibleEmployee = { employeeNumber: responsibleEmployeeNumber };
    }
  };

  if (projectNumber === undefined) {
    if (!flat.name || projectGroupNumber === undefined || customerNumber === undefined || responsibleEmployeeNumber === undefined) {
      return errorResult(
        'Creating a project requires name, projectGroupNumber, customerNumber, and responsibleEmployeeNumber.',
      );
    }

    const body: GatewayJsonObject = { ...additional, ...flat };
    applyRefs(body);

    const denied = writePolicyDenial(policy, {
      capability: 'upsert_project',
      serviceId: 'projects',
      method: 'POST',
      path: '/Projects',
      body,
    });
    if (denied) {
      return denied;
    }

    return jsonResult('Created e-conomic project.', await callEndpoint(client, {
      serviceId: 'projects',
      method: 'POST',
      pathTemplate: '/Projects',
      body,
    }));
  }

  let existing: GatewayJsonObject;
  try {
    existing = (await callEndpoint(client, {
      serviceId: 'projects',
      method: 'GET',
      pathTemplate: '/Projects/{number}',
      pathParams: { number: projectNumber },
    })) as GatewayJsonObject;
  } catch (error) {
    if (error instanceof EconomicHttpError && error.status === 404) {
      return errorResult(`Project ${projectNumber} does not exist; omit projectNumber to create a new project.`);
    }
    throw error;
  }

  const body: GatewayJsonObject = { ...existing, ...additional, ...flat, projectNumber };
  applyRefs(body);

  const denied = writePolicyDenial(policy, {
    capability: 'upsert_project',
    serviceId: 'projects',
    method: 'PUT',
    path: '/Projects',
    body,
  });
  if (denied) {
    return denied;
  }

  return jsonResult('Updated e-conomic project.', await callEndpoint(client, {
    serviceId: 'projects',
    method: 'PUT',
    pathTemplate: '/Projects',
    body,
  }));
}

// Project time registration: POST /TimeEntries with project + activity +
// employee + date + hours. The Projects API supports create and delete only
// (no update), so this tool creates; deleting a registration is a separate op.
async function createTimeEntry(
  client: EconomicClient,
  input: GatewayJsonObject,
  policy: EconomicPolicy,
): Promise<GatewayToolResult> {
  const projectNumber = numberValue(input.projectNumber);
  const activityNumber = numberValue(input.activityNumber);
  const employeeNumber = numberValue(input.employeeNumber);
  const date = stringValue(input.date);
  const hours = numberValue(input.hours);

  if (projectNumber === undefined || activityNumber === undefined || employeeNumber === undefined || !date || hours === undefined) {
    return errorResult('create_time_entry requires projectNumber, activityNumber, employeeNumber, date, and hours.');
  }

  const additional = objectValue(input.additionalFields) ?? {};
  const body: GatewayJsonObject = {
    ...additional,
    date,
    hours,
    project: { projectNumber },
    activity: { activityNumber },
    employee: { employeeNumber },
  };
  const description = stringValue(input.description);
  if (description) {
    body.description = description;
  }

  const denied = writePolicyDenial(policy, {
    capability: 'create_time_entry',
    serviceId: 'projects',
    method: 'POST',
    path: '/TimeEntries',
    body,
  });
  if (denied) {
    return denied;
  }

  return jsonResult('Registered e-conomic project time.', await callEndpoint(client, {
    serviceId: 'projects',
    method: 'POST',
    pathTemplate: '/TimeEntries',
    body,
  }));
}

async function firstLayoutNumber(client: EconomicClient): Promise<number | undefined> {
  const layouts = (await client.rest('/layouts')) as { collection?: Array<{ layoutNumber?: number }> };
  return layouts.collection?.[0]?.layoutNumber;
}

function notesObject(value: GatewayJsonValue | undefined): GatewayJsonObject | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  const notes: GatewayJsonObject = {};
  const heading = stringValue(value.heading);
  if (heading) {
    notes.heading = heading;
  }
  const textLine1 = stringValue(value.textLine1);
  if (textLine1) {
    notes.textLine1 = textLine1;
  }
  return Object.keys(notes).length > 0 ? notes : undefined;
}

function numberValue(value: GatewayJsonValue | undefined): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) {
    return Number(value);
  }
  return undefined;
}

function queryValue(value: GatewayJsonValue | undefined): Record<string, QueryValue> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }

  const query: Record<string, QueryValue> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === 'string' || typeof entry === 'number' || typeof entry === 'boolean' || entry === null) {
      query[key] = entry;
    }
  }

  return query;
}

function stringValue(value: GatewayJsonValue | undefined): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function stringOrNumberValue(value: GatewayJsonValue | undefined): string | number | undefined {
  return typeof value === 'string' || typeof value === 'number' ? value : undefined;
}

function objectValue(value: GatewayJsonValue | undefined): GatewayJsonObject | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : undefined;
}

function assertEconomicUrl(value: string): void {
  const url = new URL(value);
  if (!['restapi.e-conomic.com', 'apis.e-conomic.com'].includes(url.hostname)) {
    throw new Error('selfUrl must point to a supported e-conomic API host.');
  }
}

function jsonResult(text: string, structuredContent: unknown): GatewayToolResult {
  return {
    content: [{ type: 'text', text }],
    structuredContent: toGatewayJson(structuredContent),
  };
}

function errorResult(text: string): GatewayToolResult {
  return {
    isError: true,
    content: [{ type: 'text', text }],
  };
}

function toGatewayJson(value: unknown): GatewayJsonValue {
  return JSON.parse(JSON.stringify(value ?? null)) as GatewayJsonValue;
}
