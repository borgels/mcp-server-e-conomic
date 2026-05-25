import { EconomicClient, type EconomicClientOptions, type QueryValue } from './economic/client.js';
import { callEndpoint } from './economic/endpoints.js';

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

export interface EconomicGatewayOptions extends EconomicClientOptions {}

const emptyInput = {
  type: 'object',
  properties: {},
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
];

export function createEconomicGateway(options: EconomicGatewayOptions = {}) {
  const client = new EconomicClient(options);

  return {
    tools: economicGatewayTools,
    async callTool(toolName: string, input: GatewayJsonObject = {}): Promise<GatewayToolResult> {
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

        default:
          return errorResult(`Unsupported e-conomic gateway tool: ${toolName}`);
      }
    },
  };
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
