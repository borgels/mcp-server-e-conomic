import { EconomicClient, type QueryValue } from './economic/client.js';
import {
  ECONOMIC_SERVICES,
  ENDPOINT_OPERATIONS,
  findEndpoint,
  findService,
  resolveReadPathTemplate,
  type ApiSurface,
  type CapabilityRisk,
} from './economic/catalog.js';
import { callEndpoint, resolveSelfUrl } from './economic/endpoints.js';
import { encodePathParam } from './economic/path-params.js';
import { basePolicy, checkPolicy, type EconomicPolicy } from './economic/policy.js';
import { EconomicHttpError, SecretRedactor, formatUnknownError } from './errors.js';
import {
  economicGatewayContractEntity,
  economicGatewayContractFixture,
  economicGatewayContractSelf,
} from './economic/gateway-fixtures.js';

/**
 * Embeddable entry point: an embedding host (for example an MCP gateway that
 * does its own per-user authorization and logging) lists the tools, reads the
 * catalog, and invokes `callTool` with a per-call context.
 *
 * The embedded surface never reads ECONOMIC_* environment variables: the app
 * secret token and addresses come from the factory options, the agreement
 * grant token from the call context (or the options), and writes are enabled
 * only by `enableWrites`. Token values are redacted by a redactor owned by the
 * gateway instance, not by process-wide state.
 */

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

/** Per-tenant credential passed with a call. */
export interface EconomicGatewayCredentials {
  /** The agreement grant token of the company the call is for. */
  agreementGrantToken: string;
}

/**
 * Per-call context. `caller` and `requestId` have the same shape as the other
 * servers' gateways; this package does not send them to e-conomic or store
 * them. When `credentials` is present it is the only source of the agreement
 * grant token for the call (there is no fallback to the factory options).
 */
export interface GatewayCallContext {
  caller?: string;
  requestId?: string;
  credentials?: EconomicGatewayCredentials;
}

export interface EconomicGatewayOptions {
  /** The app's secret token. Required unless `contractMode` is on. */
  appSecretToken?: string;
  /**
   * Agreement grant token for a single-tenant host. A multi-tenant host leaves
   * it out and passes `credentials` in each call's context.
   */
  agreementGrantToken?: string;
  /** Default https://restapi.e-conomic.com. */
  restBaseUrl?: string;
  /** Default https://apis.e-conomic.com. */
  openApiBaseUrl?: string;
  fetchImpl?: typeof fetch;
  /** Per-request time limit. Default 30 seconds. */
  timeoutMs?: number;
  /** Answer from built-in fixtures; no credentials, no requests. */
  contractMode?: boolean;
  /**
   * Allow the write-risk tools to execute. A hosting control plane that applies
   * its own write governance (roles, approvals, audit) passes `true`. The
   * built-in write policy (denied paths such as booking) still applies on top.
   * The ECONOMIC_ENABLE_WRITES environment flag does not apply here.
   */
  enableWrites?: boolean;
}

/** One e-conomic service and resource, as named in the service catalog. */
export interface EconomicResourceRef {
  readonly serviceId: string;
  readonly resource: string;
}

export interface EconomicToolCatalogEntry {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly riskLevel: GatewayRiskLevel;
  readonly enabledByDefault: boolean;
  readonly inputSchema: GatewayJsonObject;
  /**
   * True for the one tool that can read any read endpoint in the service
   * catalog (`get_entity`). A host should give it only to callers that may read
   * all of the agreement's data.
   */
  readonly broad: boolean;
  /** The resources the tool may read. For a read tool this is the list enforced before any request. */
  readonly reads: readonly EconomicResourceRef[];
  /** The resources the tool may write. Empty for read tools. */
  readonly writes: readonly EconomicResourceRef[];
  /** What a narrow read tool reads when the input names no service or resource. */
  readonly defaultRead?: EconomicResourceRef;
}

export interface EconomicServiceCatalogEntry {
  readonly id: string;
  readonly name: string;
  readonly surface: ApiSurface;
  readonly servicePath: string;
  readonly resources: readonly string[];
}

export interface EconomicEndpointCatalogEntry {
  readonly id: string;
  readonly serviceId: string;
  readonly method: string;
  readonly pathTemplate: string;
  /** 'read' for GET, 'write' for everything else. */
  readonly access: 'read' | 'write';
  readonly risk: CapabilityRisk;
}

export interface EconomicServiceCatalog {
  readonly services: readonly EconomicServiceCatalogEntry[];
  readonly endpoints: readonly EconomicEndpointCatalogEntry[];
}

/** What a read tool call will read, resolved before any request is sent. */
export interface EconomicReadTarget {
  readonly serviceId: string;
  readonly resource: string;
  readonly method: 'GET';
  readonly pathTemplate: string;
  readonly pathParams?: Readonly<Record<string, string | number>>;
}

export type EconomicReadTargetResolution =
  | { readonly ok: true; readonly target: EconomicReadTarget }
  | { readonly ok: false; readonly reason: string };

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

// Chart-of-accounts write (classic REST /accounts). Elevated: editing the CoA
// is a structural change, so this is risk 'destructive' and the hosting control
// plane gates it behind approval. accountType-specific required fields vary, so
// only the always-required keys are validated here; additionalFields carries the
// rest and e-conomic validates on write.
const upsertAccountInput = {
  type: 'object',
  properties: {
    accountNumber: {
      type: 'number',
      description: 'Account number (the account key). Updates the account when it exists (read-merge-write), creates it otherwise.',
    },
    name: { type: 'string', description: 'Account name. Required when creating.' },
    accountType: {
      type: 'string',
      description: 'Account type, e.g. profitAndLoss, status, heading, headingStart, sumInterval, sumAlpha, totalFrom. Required when creating.',
    },
    blockDirectEntries: { type: 'boolean', description: 'Block direct entries on the account.' },
    vatCode: { type: 'string', description: 'Default VAT code for the account.' },
    additionalFields: {
      type: 'object',
      description: 'Optional additional account fields (accountType-specific, passthrough).',
      additionalProperties: true,
    },
  },
  required: ['accountNumber'],
  additionalProperties: false,
} satisfies GatewayJsonObject;

const DEFAULT_REST_BASE_URL = 'https://restapi.e-conomic.com';
const DEFAULT_OPENAPI_BASE_URL = 'https://apis.e-conomic.com';
const DEFAULT_TIMEOUT_MS = 30_000;

const ref = (serviceId: string, resource: string): EconomicResourceRef => ({ serviceId, resource });

/** The fixed endpoint behind check_connection and company_context (not reachable through get_entity). */
const SELF = ref('rest', 'self');

/**
 * What each narrow read tool may read. The first entry is the default. These
 * lists are enforced before any request is sent and published as `reads` in
 * `economicToolCatalog`.
 */
const NARROW_READ_TARGETS: Record<string, readonly EconomicResourceRef[]> = {
  search_entities: [
    ref('rest', 'customers'),
    ref('rest', 'suppliers'),
    ref('rest', 'products'),
    ref('rest', 'accounts'),
    ref('projects', 'Projects'),
  ],
  customer_overview: [
    ref('customers', 'Customers'),
    ref('customers', 'Contacts'),
    ref('customers', 'DeliveryLocations'),
    ref('rest', 'customers'),
    ref('rest', 'customer-groups'),
  ],
  supplier_overview: [
    ref('rest', 'suppliers'),
    ref('rest', 'supplier-groups'),
    ref('suppliers', 'Contacts'),
    ref('suppliers', 'Groups'),
  ],
  product_overview: [
    ref('products', 'products'),
    ref('products', 'productgroups'),
    ref('products', 'pricegroups'),
    ref('products', 'salespriceincurrencies'),
    ref('products', 'specialprices'),
    ref('rest', 'products'),
    ref('rest', 'product-groups'),
    ref('rest', 'units'),
  ],
  report_data: [
    ref('accounts', 'Accounts'),
    ref('accounts', 'KeyFigureCodes'),
    ref('accounts', 'TotalIntervals'),
    ref('rest', 'accounts'),
    ref('rest', 'accounting-years'),
    ref('accounting-years', 'AccountingYears'),
    ref('accounting-years', 'accountingYears/periods'),
    ref('budgets', 'budget-figures'),
  ],
  invoice_overview: [
    ref('rest', 'invoices/booked'),
    ref('rest', 'invoices/unpaid'),
    ref('rest', 'invoices/overdue'),
    ref('rest', 'invoices/paid'),
    ref('rest', 'invoices/sent'),
    ref('rest', 'invoices/drafts'),
  ],
  project_overview: [
    ref('projects', 'Projects'),
    ref('projects', 'ProjectGroups'),
    ref('projects', 'ProjectStatuses'),
    ref('projects', 'CostTypes'),
    ref('projects', 'Activities'),
    ref('projects', 'ActivityGroups'),
    ref('projects', 'Employees'),
    ref('projects', 'EmployeeGroups'),
    ref('projects', 'TimeEntries'),
  ],
  accounting_entries: [
    ref('booked-entries', 'booked-entries'),
    ref('booked-entries', 'booked-entries/matched-pairs'),
    ref('journals', 'draft-entries'),
  ],
};

/** Every resource with read endpoints in the service catalog: what the broad get_entity may read. */
const ALL_READ_TARGETS: readonly EconomicResourceRef[] = ECONOMIC_SERVICES.flatMap(service =>
  service.resources.map(resource => ref(service.id, resource)),
);

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function pairList(targets: readonly EconomicResourceRef[]): string {
  return targets.map(target => `${target.serviceId}:${target.resource}`).join(', ');
}

function narrowReadInput(targets: readonly EconomicResourceRef[]): GatewayJsonObject {
  const [first] = targets;
  return {
    type: 'object',
    properties: {
      serviceId: {
        type: 'string',
        enum: unique(targets.map(target => target.serviceId)),
        description: `e-conomic service. Allowed serviceId:resource pairs: ${pairList(targets)}. Default ${first?.serviceId}:${first?.resource}.`,
      },
      resource: {
        type: 'string',
        enum: unique(targets.map(target => target.resource)),
        description: 'Resource within the service. Without serviceId, the first allowed pair with this resource is used.',
      },
      number: { type: ['string', 'number'], description: 'Optional entity number/id for a direct lookup.' },
      paged: { type: 'boolean', description: 'OpenAPI services: use the /paged collection endpoint when no number is supplied (default true).' },
      query: {
        type: 'object',
        description: 'Optional query parameters passed to e-conomic (paging, filter, sort).',
        additionalProperties: true,
      },
    },
    additionalProperties: false,
  };
}

const getEntityInput = {
  type: 'object',
  properties: {
    serviceId: { type: 'string', enum: ECONOMIC_SERVICES.map(service => service.id) },
    resource: { type: 'string', enum: unique(ALL_READ_TARGETS.map(target => target.resource)) },
    number: { type: ['string', 'number'] },
    selfUrl: { type: 'string', description: 'An e-conomic self URL that matches a read endpoint in the catalog.' },
    query: { type: 'object', additionalProperties: true },
  },
  additionalProperties: false,
} satisfies GatewayJsonObject;

interface ToolSpec extends GatewayToolDefinition {
  broad: boolean;
  reads: readonly EconomicResourceRef[];
  writes: readonly EconomicResourceRef[];
}

function narrowReadTool(name: string, title: string, description: string): ToolSpec {
  const reads = NARROW_READ_TARGETS[name] ?? [];
  return {
    name,
    title,
    description,
    riskLevel: 'read',
    enabledByDefault: true,
    inputSchema: narrowReadInput(reads),
    broad: false,
    reads,
    writes: [],
  };
}

function writeTool(
  spec: Omit<ToolSpec, 'riskLevel' | 'enabledByDefault' | 'broad'> & { riskLevel?: GatewayRiskLevel },
): ToolSpec {
  return { ...spec, riskLevel: spec.riskLevel ?? 'write', enabledByDefault: false, broad: false };
}

const WRITE_NOTE =
  'Write — disabled by default; enable via the gateway’s enableWrites option (standalone server: ECONOMIC_ENABLE_WRITES).';

const TOOL_SPECS: ToolSpec[] = [
  {
    name: 'check_connection',
    title: 'Check e-conomic connection',
    description: 'Verify that the credentials can access the e-conomic API. Returns only whether the connection works.',
    riskLevel: 'read',
    enabledByDefault: true,
    inputSchema: emptyInput,
    broad: false,
    reads: [SELF],
    writes: [],
  },
  {
    name: 'company_context',
    title: 'Get e-conomic company context',
    description:
      'Read the company name, address, CVR/VAT number, agreement number and type, enabled modules, and the settings the other tools need (base currency, international ledger). Bank details and user data are not returned.',
    riskLevel: 'read',
    enabledByDefault: true,
    inputSchema: emptyInput,
    broad: false,
    reads: [SELF],
    writes: [],
  },
  narrowReadTool(
    'search_entities',
    'Search e-conomic master data',
    'List master data: customers (default), suppliers, products, ledger accounts, or projects. Entries, invoices and documents are read with their own tools.',
  ),
  {
    name: 'get_entity',
    title: 'Get any e-conomic record (broad)',
    description:
      'Fetch one record from any read endpoint in the catalog, by serviceId/resource/number or by an e-conomic self URL. Broad: it can read everything the other tools read, including booked entries, invoices and documents. Give it only to callers that may read all of the agreement’s data.',
    riskLevel: 'read',
    enabledByDefault: true,
    inputSchema: getEntityInput,
    broad: true,
    reads: ALL_READ_TARGETS,
    writes: [],
  },
  narrowReadTool(
    'customer_overview',
    'Get e-conomic customer overview',
    'Read customers (default), customer contacts, delivery locations, or customer groups. Reads customer resources only.',
  ),
  narrowReadTool(
    'supplier_overview',
    'Get e-conomic supplier overview',
    'Read suppliers (default), supplier groups, or supplier contacts. Reads supplier resources only.',
  ),
  narrowReadTool(
    'product_overview',
    'Get e-conomic product overview',
    'Read products (default), product groups, price groups, prices in currencies, special prices, or units. Reads product resources only.',
  ),
  narrowReadTool(
    'report_data',
    'Get e-conomic report data',
    'Read the chart of accounts (default), key figure codes, total intervals, accounting years and periods, and budget figures for reporting. Booked entries are read with accounting_entries.',
  ),
  narrowReadTool(
    'invoice_overview',
    'Get e-conomic invoice overview',
    'List booked invoices (default) or an invoice collection (booked, unpaid, overdue, paid, sent, drafts) for revenue and receivables reporting. Supports query paging (skippages, pagesize) and filters.',
  ),
  narrowReadTool(
    'project_overview',
    'Get e-conomic project overview',
    'Read the Projects add-on: projects (default), project groups and statuses, cost types, activities and activity groups, employees and employee groups, or time entries.',
  ),
  narrowReadTool(
    'accounting_entries',
    'Get e-conomic accounting entries',
    'Read booked accounting entries (default), matched pairs of booked entries, or journal draft entries. Used for ledger, supplier-invoice, and reconciliation reads. Supports paging and filters.',
  ),
  writeTool({
    name: 'create_draft_invoice',
    title: 'Create e-conomic draft invoice',
    description: `Create a draft (unbooked, unsent) sales invoice for a customer. Drafts can be reviewed or deleted and are not booked or sent; this does not post anything to the customer. ${WRITE_NOTE}`,
    inputSchema: createDraftInvoiceInput,
    reads: [ref('rest', 'customers'), ref('rest', 'layouts')],
    writes: [ref('rest', 'invoices/drafts')],
  }),
  writeTool({
    name: 'upsert_customer',
    title: 'Create or update e-conomic customer',
    description: `Create a customer, or update an existing one by customerNumber (reads the current customer and merges the provided fields). ${WRITE_NOTE}`,
    inputSchema: upsertCustomerInput,
    reads: [ref('rest', 'customers')],
    writes: [ref('rest', 'customers')],
  }),
  writeTool({
    name: 'upsert_product',
    title: 'Create or update e-conomic product',
    description: `Create a product, or update it when the productNumber already exists (reads the current product and merges the provided fields). ${WRITE_NOTE}`,
    inputSchema: upsertProductInput,
    reads: [ref('rest', 'products')],
    writes: [ref('rest', 'products')],
  }),
  writeTool({
    name: 'upsert_project',
    title: 'Create or update e-conomic project',
    description: `Create a project in the Projects add-on, or update an existing one by projectNumber (reads the current project and merges the provided fields; upserts via the collection PUT). ${WRITE_NOTE}`,
    inputSchema: upsertProjectInput,
    reads: [ref('projects', 'Projects')],
    writes: [ref('projects', 'Projects')],
  }),
  writeTool({
    name: 'create_time_entry',
    title: 'Register e-conomic project time',
    description: `Register a project time entry (hours on a project + activity for an employee, on a date). Create only; deletion is a separate operation. ${WRITE_NOTE}`,
    inputSchema: createTimeEntryInput,
    reads: [],
    writes: [ref('projects', 'TimeEntries')],
  }),
  writeTool({
    name: 'upsert_supplier',
    title: 'Create or update e-conomic supplier',
    description: `Create a supplier, or update an existing one by supplierNumber (reads the current supplier and merges the provided fields). ${WRITE_NOTE}`,
    inputSchema: upsertSupplierInput,
    reads: [ref('rest', 'suppliers')],
    writes: [ref('rest', 'suppliers')],
  }),
  writeTool({
    name: 'upsert_employee',
    title: 'Create or update e-conomic project employee',
    description: `Create a Projects add-on employee, or update an existing one by employeeNumber (collection upsert, read-merge-write). ${WRITE_NOTE}`,
    inputSchema: upsertEmployeeInput,
    reads: [ref('projects', 'Employees')],
    writes: [ref('projects', 'Employees')],
  }),
  writeTool({
    name: 'upsert_account',
    title: 'Create or update e-conomic ledger account',
    description: `Create a general-ledger account, or update an existing one by accountNumber (read-merge-write). Editing the chart of accounts is a structural change (risk destructive); a hosting control plane should gate it behind approval. ${WRITE_NOTE}`,
    riskLevel: 'destructive',
    inputSchema: upsertAccountInput,
    reads: [ref('rest', 'accounts')],
    writes: [ref('rest', 'accounts')],
  }),
];

const SPEC_BY_NAME = new Map(TOOL_SPECS.map(spec => [spec.name, spec]));

export const economicGatewayTools: GatewayToolDefinition[] = TOOL_SPECS.map(spec => ({
  name: spec.name,
  title: spec.title,
  description: spec.description,
  riskLevel: spec.riskLevel,
  enabledByDefault: spec.enabledByDefault,
  inputSchema: structuredClone(spec.inputSchema),
}));

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value)) {
      deepFreeze(nested);
    }
  }
  return value;
}

/**
 * The tool catalog, generated from the tool table and frozen: for each tool its
 * definition, whether it is broad, and the resources it reads and writes.
 */
export const economicToolCatalog: readonly EconomicToolCatalogEntry[] = deepFreeze(
  TOOL_SPECS.map(spec => {
    const defaultRead = spec.broad ? undefined : NARROW_READ_TARGETS[spec.name]?.[0];
    const entry: EconomicToolCatalogEntry = {
      name: spec.name,
      title: spec.title,
      description: spec.description,
      riskLevel: spec.riskLevel,
      enabledByDefault: spec.enabledByDefault,
      inputSchema: structuredClone(spec.inputSchema),
      broad: spec.broad,
      reads: spec.reads.map(target => ({ ...target })),
      writes: spec.writes.map(target => ({ ...target })),
      ...(defaultRead ? { defaultRead: { ...defaultRead } } : {}),
    };
    return entry;
  }),
);

/** The services, resources and endpoints the server knows, with read/write marking. Frozen. */
export const economicServiceCatalog: EconomicServiceCatalog = deepFreeze({
  services: ECONOMIC_SERVICES.map(service => ({
    id: service.id,
    name: service.name,
    surface: service.surface,
    servicePath: service.servicePath,
    resources: [...service.resources],
  })),
  endpoints: ENDPOINT_OPERATIONS.map(endpoint => ({
    id: endpoint.id,
    serviceId: endpoint.serviceId,
    method: endpoint.method,
    pathTemplate: endpoint.pathTemplate,
    access: endpoint.method === 'GET' ? ('read' as const) : ('write' as const),
    risk: endpoint.risk,
  })),
});

function refuse(reason: string): EconomicReadTargetResolution {
  return { ok: false, reason };
}

function unknownInputFields(spec: ToolSpec, input: GatewayJsonObject): string[] {
  const properties = spec.inputSchema.properties;
  const known = properties && typeof properties === 'object' && !Array.isArray(properties) ? Object.keys(properties) : [];
  return Object.keys(input).filter(key => !known.includes(key));
}

/** A string option: absent when undefined, null or blank; otherwise it must be a string. */
function optionalString(input: GatewayJsonObject, key: string): { ok: true; value?: string } | { ok: false } {
  const value = input[key];
  if (value === undefined || value === null) return { ok: true };
  if (typeof value !== 'string') return { ok: false };
  const trimmed = value.trim();
  return trimmed ? { ok: true, value: trimmed } : { ok: true };
}

function resourceOfTemplate(serviceId: string, pathTemplate: string): string | undefined {
  const resources = [...findService(serviceId).resources].sort((a, b) => b.length - a.length);
  return resources.find(resource => pathTemplate === `/${resource}` || pathTemplate.startsWith(`/${resource}/`));
}

/**
 * Resolves what a read tool call will read, with the same checks callTool
 * applies before sending anything: unknown fields, the tool's fixed target
 * list, and the endpoint allowlist. An embedder can use it to log exactly what
 * a call reads.
 */
export function resolveEconomicReadTarget(
  toolName: string,
  input: GatewayJsonObject = {},
): EconomicReadTargetResolution {
  const spec = typeof toolName === 'string' ? SPEC_BY_NAME.get(toolName) : undefined;
  if (!spec) return refuse(`Unsupported e-conomic gateway tool: ${String(toolName).slice(0, 100)}`);
  if (spec.riskLevel !== 'read') return refuse(`${spec.name} is not a read tool.`);
  if (!input || typeof input !== 'object' || Array.isArray(input)) return refuse('Input must be an object.');
  const unknown = unknownInputFields(spec, input);
  if (unknown.length > 0) {
    return refuse(`Unknown input field(s) for ${spec.name}: ${unknown.map(key => key.slice(0, 40)).join(', ')}.`);
  }

  if (spec.name === 'check_connection' || spec.name === 'company_context') {
    return { ok: true, target: { serviceId: SELF.serviceId, resource: SELF.resource, method: 'GET', pathTemplate: '/self' } };
  }

  const serviceId = optionalString(input, 'serviceId');
  const resource = optionalString(input, 'resource');
  if (!serviceId.ok || !resource.ok) return refuse('serviceId and resource must be strings.');
  const number = input.number;
  if (number !== undefined && number !== null && typeof number !== 'string' && typeof number !== 'number') {
    return refuse('number must be a string or a number.');
  }
  const numberValue = number === null || number === '' ? undefined : number;
  if (input.paged !== undefined && typeof input.paged !== 'boolean') return refuse('paged must be true or false.');

  try {
    if (spec.broad) {
      const selfUrl = optionalString(input, 'selfUrl');
      if (!selfUrl.ok) return refuse('selfUrl must be a string.');
      if (selfUrl.value !== undefined) {
        const resolved = resolveSelfUrl(selfUrl.value);
        const selfResource = resourceOfTemplate(resolved.serviceId, resolved.pathTemplate);
        if (!selfResource) return refuse('selfUrl does not match a resource in the catalog.');
        return {
          ok: true,
          target: {
            serviceId: resolved.serviceId,
            resource: selfResource,
            method: 'GET',
            pathTemplate: resolved.pathTemplate,
            ...(resolved.pathParams ? { pathParams: resolved.pathParams } : {}),
          },
        };
      }
      if (!serviceId.value || !resource.value || numberValue === undefined) {
        return refuse('Provide either selfUrl or serviceId, resource, and number.');
      }
      const known = spec.reads.some(target => target.serviceId === serviceId.value && target.resource === resource.value);
      if (!known) return refuse(`${serviceId.value}:${resource.value} is not a resource in the catalog.`);
      encodePathParam(numberValue, 'number');
      const pathTemplate = `/${resource.value}/{number}`;
      findEndpoint(serviceId.value, 'GET', pathTemplate);
      return {
        ok: true,
        target: { serviceId: serviceId.value, resource: resource.value, method: 'GET', pathTemplate, pathParams: { number: numberValue } },
      };
    }

    const target = spec.reads.find(
      candidate =>
        (serviceId.value === undefined || candidate.serviceId === serviceId.value)
        && (resource.value === undefined || candidate.resource === resource.value),
    );
    if (!target) {
      return refuse(`${spec.name} reads only these serviceId:resource pairs: ${pairList(spec.reads)}.`);
    }
    if (numberValue !== undefined) encodePathParam(numberValue, 'number');
    const pathTemplate = resolveReadPathTemplate(target.serviceId, target.resource, {
      number: numberValue,
      paged: input.paged !== false,
    });
    findEndpoint(target.serviceId, 'GET', pathTemplate);
    return {
      ok: true,
      target: {
        serviceId: target.serviceId,
        resource: target.resource,
        method: 'GET',
        pathTemplate,
        ...(numberValue === undefined ? {} : { pathParams: { number: numberValue } }),
      },
    };
  } catch (error) {
    return refuse(formatUnknownError(error));
  }
}

/**
 * The parts of GET /self that company_context promises. Everything else (bank
 * details, the granting user, the app's tokens, contact data) is dropped.
 */
function companyContextFromSelf(self: unknown): GatewayJsonObject {
  const source = asObject(self);
  const company = asObject(source.company);
  const settings = asObject(source.settings);
  const agreementType = asObject(source.agreementType);
  const modules = Array.isArray(source.modules) ? source.modules : [];
  return {
    agreementNumber: scalar(source.agreementNumber),
    agreementType: scalar(agreementType.name),
    company: {
      name: scalar(company.name),
      addressLine1: scalar(company.addressLine1),
      addressLine2: scalar(company.addressLine2),
      zip: scalar(company.zip),
      city: scalar(company.city),
      country: scalar(company.country),
      companyIdentificationNumber: scalar(company.companyIdentificationNumber),
      vatNumber: scalar(company.vatNumber),
    },
    modules: modules.map(module => {
      const item = asObject(module);
      return { moduleNumber: scalar(item.moduleNumber), name: scalar(item.name) };
    }),
    settings: {
      baseCurrency: scalar(settings.baseCurrency),
      internationalLedger: scalar(settings.internationalLedger),
    },
  };
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function scalar(value: unknown): string | number | boolean | null {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' ? value : null;
}

/** A short answer text for a read result: what was read and how many records, never the data itself. */
function readSummary(toolName: string, target: EconomicReadTarget, data: unknown): string {
  const where = `${target.serviceId}:${target.resource}`;
  if (target.pathParams && Object.keys(target.pathParams).length > 0) {
    return `${toolName}: one record from ${where}.`;
  }
  const source = asObject(data);
  const items = Array.isArray(data)
    ? data
    : Array.isArray(source.collection)
      ? source.collection
      : Array.isArray(source.items)
        ? source.items
        : undefined;
  if (!items) {
    return `${toolName}: read ${where}.`;
  }
  const pagination = asObject(source.pagination);
  const total = typeof pagination.results === 'number' ? pagination.results : undefined;
  const records = items.length === 1 ? 'record' : 'records';
  return total !== undefined && total > items.length
    ? `${toolName}: ${items.length} of ${total} ${records} from ${where}. More pages are available.`
    : `${toolName}: ${items.length} ${records} from ${where}.`;
}

export function createEconomicGateway(options: EconomicGatewayOptions = {}) {
  const contractMode = options.contractMode === true;
  const appSecretToken = nonEmptyString(options.appSecretToken);
  if (!contractMode && !appSecretToken) {
    throw new Error(
      'createEconomicGateway: appSecretToken is required outside contract mode (the gateway does not read ECONOMIC_* environment variables).',
    );
  }
  if (options.agreementGrantToken !== undefined && !nonEmptyString(options.agreementGrantToken)) {
    throw new Error('createEconomicGateway: agreementGrantToken must be a non-empty string when given.');
  }

  const redactor = new SecretRedactor();
  redactor.add(appSecretToken);
  redactor.add(options.agreementGrantToken);
  const clientOptions = {
    appSecretToken,
    restBaseUrl: options.restBaseUrl ?? DEFAULT_REST_BASE_URL,
    openApiBaseUrl: options.openApiBaseUrl ?? DEFAULT_OPENAPI_BASE_URL,
    fetchImpl: options.fetchImpl,
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    // Never read the environment on the embedded path.
    env: {},
  };
  // Validates the base URLs at creation.
  new EconomicClient({ ...clientOptions, redactor: redactor.fork() });

  const writePolicy: EconomicPolicy = { ...basePolicy(), writesEnabled: options.enableWrites === true };

  return {
    tools: economicGatewayTools,
    async callTool(
      toolName: string,
      input: GatewayJsonObject = {},
      context?: GatewayCallContext,
    ): Promise<GatewayToolResult> {
      const callRedactor = redactor.fork();
      try {
        const spec = typeof toolName === 'string' ? SPEC_BY_NAME.get(toolName) : undefined;
        if (!spec) {
          return errorResult(`Unsupported e-conomic gateway tool: ${String(toolName).slice(0, 100)}`);
        }
        const args: GatewayJsonObject = input ?? {};
        if (typeof args !== 'object' || Array.isArray(args)) {
          return errorResult('Input must be an object.');
        }

        let target: EconomicReadTarget | undefined;
        if (spec.riskLevel === 'read') {
          const resolution = resolveEconomicReadTarget(spec.name, args);
          if (!resolution.ok) {
            return errorResult(resolution.reason);
          }
          target = resolution.target;
        } else {
          const unknown = unknownInputFields(spec, args);
          if (unknown.length > 0) {
            return errorResult(`Unknown input field(s) for ${spec.name}: ${unknown.map(key => key.slice(0, 40)).join(', ')}.`);
          }
        }

        if (contractMode) {
          return contractToolResult(spec.name, args, target);
        }

        const grant = callGrantToken(context, options.agreementGrantToken);
        if (!grant) {
          return errorResult(
            'Missing e-conomic agreement grant token: pass credentials.agreementGrantToken in the call context or agreementGrantToken in the gateway options.',
          );
        }
        callRedactor.add(grant);
        const client = new EconomicClient({ ...clientOptions, agreementGrantToken: grant, redactor: callRedactor });

        if (target) {
          return await readResult(client, spec.name, target, args);
        }
        return await writeResult(client, spec.name, args, writePolicy);
      } catch (error) {
        return errorResult(formatUnknownError(error, callRedactor));
      }
    },
  };
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** The call's agreement grant token. A context with credentials is the only source; there is no fallback from it. */
function callGrantToken(context: GatewayCallContext | undefined, fallback: string | undefined): string | undefined {
  if (context && context.credentials !== undefined) {
    return nonEmptyString(context.credentials?.agreementGrantToken);
  }
  return nonEmptyString(fallback);
}

async function readResult(
  client: EconomicClient,
  toolName: string,
  target: EconomicReadTarget,
  input: GatewayJsonObject,
): Promise<GatewayToolResult> {
  if (toolName === 'check_connection') {
    await client.rest('/self');
    return jsonResult('e-conomic connection is available.', { connected: true });
  }
  if (toolName === 'company_context') {
    return jsonResult(
      'company_context: company, agreement, modules and settings.',
      companyContextFromSelf(await client.rest('/self')),
    );
  }

  const selfUrl = typeof input.selfUrl === 'string' && input.selfUrl.trim() ? input.selfUrl.trim() : undefined;
  // A self URL may carry its own query (paging, filter); keep it, as resolveSelfUrl does.
  const query = selfUrl
    ? resolveSelfUrl(selfUrl, queryValue(input.query)).query
    : queryValue(input.query);
  const data = await callEndpoint(client, {
    serviceId: target.serviceId,
    method: 'GET',
    pathTemplate: target.pathTemplate,
    pathParams: target.pathParams ? { ...target.pathParams } : undefined,
    query,
  });
  return jsonResult(readSummary(toolName, target, data), data);
}

async function writeResult(
  client: EconomicClient,
  toolName: string,
  input: GatewayJsonObject,
  writePolicy: EconomicPolicy,
): Promise<GatewayToolResult> {
  switch (toolName) {
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
    case 'upsert_account':
      return upsertAccount(client, input, writePolicy);
    default:
      return errorResult(`Unsupported e-conomic gateway tool: ${toolName}`);
  }
}

function contractToolResult(
  toolName: string,
  input: GatewayJsonObject,
  target: EconomicReadTarget | undefined,
): GatewayToolResult {
  if (toolName === 'check_connection') {
    return jsonResult('e-conomic connection is available.', { connected: true, mode: 'contract' });
  }
  if (toolName === 'company_context') {
    return jsonResult(
      'company_context: company, agreement, modules and settings.',
      companyContextFromSelf(economicGatewayContractSelf),
    );
  }

  const fixture = toolName === 'get_entity'
    ? economicGatewayContractEntity(input)
    : economicGatewayContractFixture(toolName, input);
  if (!fixture) {
    return errorResult(`Unsupported e-conomic gateway tool: ${toolName}`);
  }
  const text = target ? readSummary(toolName, target, fixture.structuredContent) : fixture.text;
  return jsonResult(text, fixture.structuredContent);
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
    existing = (await client.rest(`/products/${encodePathParam(productNumber, 'productNumber')}`)) as GatewayJsonObject;
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

// Chart-of-accounts write on classic REST: create POST /accounts, update full-
// object PUT /accounts/{number} (read-merge-write). Mirrors the customer/product
// upsert flow; both endpoints are already allowlisted.
async function upsertAccount(
  client: EconomicClient,
  input: GatewayJsonObject,
  policy: EconomicPolicy,
): Promise<GatewayToolResult> {
  const accountNumber = numberValue(input.accountNumber);
  if (accountNumber === undefined) {
    return errorResult('upsert_account requires an accountNumber.');
  }

  const flat: GatewayJsonObject = {};
  const name = stringValue(input.name);
  if (name) {
    flat.name = name;
  }
  const accountType = stringValue(input.accountType);
  if (accountType) {
    flat.accountType = accountType;
  }
  const vatCode = stringValue(input.vatCode);
  if (vatCode) {
    flat.vatCode = vatCode;
  }
  if (typeof input.blockDirectEntries === 'boolean') {
    flat.blockDirectEntries = input.blockDirectEntries;
  }
  const additional = objectValue(input.additionalFields) ?? {};

  let existing: GatewayJsonObject | undefined;
  try {
    existing = (await client.rest(`/accounts/${accountNumber}`)) as GatewayJsonObject;
  } catch (error) {
    if (!(error instanceof EconomicHttpError) || error.status !== 404) {
      throw error;
    }
  }

  if (!existing) {
    if (!flat.name || !flat.accountType) {
      return errorResult('Creating an account requires accountNumber, name, and accountType.');
    }

    const body: GatewayJsonObject = { ...additional, ...flat, accountNumber };
    const denied = writePolicyDenial(policy, { capability: 'upsert_account', method: 'POST', path: '/accounts', body });
    if (denied) {
      return denied;
    }

    return jsonResult('Created e-conomic account.', await callEndpoint(client, {
      serviceId: 'rest',
      method: 'POST',
      pathTemplate: '/accounts',
      body,
    }));
  }

  const body: GatewayJsonObject = { ...existing, ...additional, ...flat };
  const denied = writePolicyDenial(policy, {
    capability: 'upsert_account',
    method: 'PUT',
    path: `/accounts/${accountNumber}`,
    body,
  });
  if (denied) {
    return denied;
  }

  return jsonResult('Updated e-conomic account.', await callEndpoint(client, {
    serviceId: 'rest',
    method: 'PUT',
    pathTemplate: '/accounts/{number}',
    pathParams: { number: accountNumber },
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
