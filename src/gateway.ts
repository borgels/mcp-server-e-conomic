import { EconomicClient, type EconomicClientOptions, type QueryValue } from './economic/client.js';
import { callEndpoint } from './economic/endpoints.js';
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
    name: 'create_draft_invoice',
    title: 'Create e-conomic draft invoice',
    description:
      'Create a draft (unbooked, unsent) sales invoice for a customer. Drafts can be reviewed or deleted and are not booked or sent; this does not post anything to the customer.',
    riskLevel: 'write',
    enabledByDefault: false,
    inputSchema: createDraftInvoiceInput,
  },
];

export function createEconomicGateway(options: EconomicGatewayOptions = {}) {
  const client = new EconomicClient(options);

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

        case 'create_draft_invoice':
          return createDraftInvoice(client, input);

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

interface DraftCustomer {
  name?: string;
  currency?: string;
  paymentTerms?: { paymentTermsNumber?: number };
  vatZone?: { vatZoneNumber?: number };
}

async function createDraftInvoice(client: EconomicClient, input: GatewayJsonObject): Promise<GatewayToolResult> {
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

  const created = await callEndpoint(client, {
    serviceId: 'rest',
    method: 'POST',
    pathTemplate: '/invoices/drafts',
    body,
    idempotencyKey: stringValue(input.idempotencyKey),
  });

  return jsonResult('Created e-conomic draft invoice.', created);
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
