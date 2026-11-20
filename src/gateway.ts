import { EconomicClient, type EconomicBinaryBody, type QueryValue } from './economic/client.js';
import {
  ECONOMIC_SERVICES,
  ENDPOINT_OPERATIONS,
  findEndpoint,
  findService,
  pagedPathTemplate,
  resolveReadPathTemplate,
  type ApiSurface,
  type CapabilityRisk,
} from './economic/catalog.js';
import { callEndpoint, resolveSelfUrl } from './economic/endpoints.js';
import { encodePathParam } from './economic/path-params.js';
import { basePolicy, checkPolicy, type EconomicPolicy } from './economic/policy.js';
import { assertMatchEntryIds, draftEntryNumbersForVouchers, validateBooking } from './economic/bookings.js';
import { BANK_FIELDS_REFUSED, bankFieldPaths, changedBankFields } from './economic/bank-fields.js';
import { fenceRule } from './economic/fence.js';
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
 * grant token from the call context (or the options), and writes and booking
 * are enabled only by the host policy (`policy`, or `enableWrites`). Token
 * values are redacted by a redactor owned by the gateway instance, not by
 * process-wide state.
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
   * Same as `policy.enableWrites`; give one or the other (both must agree).
   */
  enableWrites?: boolean;
  /**
   * The host's policy for this instance: writes, booking, and which tools are
   * offered at all. Checked at creation (unknown tool names and contradictions
   * throw). Applies in contract mode too.
   */
  policy?: EconomicHostPolicy;
}

/**
 * Policy given by an embedding host for one gateway instance. Every field is
 * optional; the defaults are the safe ones (no writes, no booking, every tool
 * offered).
 *
 * What no policy can turn on: changes to bank details (supplier bank account,
 * payment details, the company's own record), the paths the built-in write
 * policy denies outside the booking tools (VAT, payment), and the fixed fence
 * in `GATEWAY_FENCE` (src/economic/fence.ts), checked in the HTTP client right
 * before any request is sent: deletion, the company's own record, bank
 * information, users, access and settings, webhooks, booking a whole journal,
 * accounting years and the chart of accounts. `upsert_account` is therefore
 * always refused by the gateway, also when a host offers it.
 */
export interface EconomicHostPolicy {
  /** Allow the write-risk tools. Default false. */
  enableWrites?: boolean;
  /**
   * Allow the booking tools (book_journal_entries, book_invoice,
   * match_open_items). They are irreversible in e-conomic. Default false.
   * Requires enableWrites.
   */
  allowBooking?: boolean;
  /** Tools turned off on this instance: not listed in `tools`, refused by callTool. Must name known tools. */
  disabledTools?: readonly string[];
  /**
   * Allow-list: when set, only these tools are offered (reads included).
   * Must name known tools and must not be empty.
   */
  allowedTools?: readonly string[];
}

/** One e-conomic service and resource, as named in the service catalog. */
export interface EconomicResourceRef {
  readonly serviceId: string;
  readonly resource: string;
}

/** Deeply read-only JSON, as found in the frozen tool catalog. */
export type GatewayReadonlyJsonValue =
  | string
  | number
  | boolean
  | null
  | readonly GatewayReadonlyJsonValue[]
  | { readonly [key: string]: GatewayReadonlyJsonValue };

/**
 * One e-conomic API request a tool may make. `access`, `method` and `path` are
 * the family's shape; `path` is relative to the REST base URL for the `rest`
 * service and to the OpenAPI base URL (including the service path) otherwise.
 * `serviceId` and `resource` are e-conomic additions naming the catalog entry.
 */
export interface GatewayUpstreamOperation {
  readonly access: 'read' | 'write';
  readonly method: 'GET' | 'POST' | 'PUT';
  readonly path: string;
  readonly serviceId: string;
  readonly resource: string;
}

/** A tool catalog entry: the gateway definition plus the e-conomic API requests the tool may make. */
export interface GatewayToolCatalogEntry {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly riskLevel: GatewayRiskLevel;
  readonly enabledByDefault: boolean;
  readonly inputSchema: { readonly [key: string]: GatewayReadonlyJsonValue };
  /**
   * Every request the tool may make. For a narrow read tool these are exactly
   * the requests its enforced target list allows.
   */
  readonly upstream: readonly GatewayUpstreamOperation[];
  /**
   * e-conomic addition: true for the one tool that can read any read endpoint
   * in the service catalog (`get_entity`). A host should give it only to
   * callers that may read all of the agreement's data.
   */
  readonly broad: boolean;
  /** e-conomic addition: what a narrow read tool reads when the input names no service or resource. */
  readonly defaultRead?: EconomicResourceRef;
  /**
   * e-conomic addition: true for the booking tools (irreversible in
   * e-conomic). They run only when the host policy sets allowBooking.
   */
  readonly booking: boolean;
  /**
   * e-conomic addition, write tools only: what the change does, for a host
   * that logs a change before it is sent. `logFields` are the input fields
   * that identify the change, each with the one type its value must have
   * (record numbers, dates, amounts, currency codes; never names or free
   * text); `resolveEconomicChange` returns their values for a call.
   */
  readonly change?: EconomicChangeSpec;
}

export type EconomicChangeAction = 'create' | 'upsert' | 'register' | 'book' | 'match';

export interface EconomicChangeSpec {
  readonly action: EconomicChangeAction;
  /** The kind of record the change creates or touches, e.g. 'payment', 'journal-entry', 'invoice'. */
  readonly record: string;
  readonly logFields: readonly EconomicLogField[];
}

/**
 * The type a logged value must have; anything else is left out of the values.
 *   recordNumber  a whole number >= 0, or a string of 1-15 digits
 *   numberList    1-100 whole numbers >= 1
 *   amount        a finite number with at most two decimals
 *   quantity      a finite number >= 0 (hours)
 *   date          an ISO date (YYYY-MM-DD) that exists
 *   currency      an ISO 4217 code written in capitals (DKK); lower case is refused
 *   accountingYear  e-conomic's year name: 2026 or 2025/2026
 *   enum          one of the input schema's enum values
 */
export type EconomicLogFieldType =
  | 'recordNumber'
  | 'numberList'
  | 'amount'
  | 'quantity'
  | 'date'
  | 'currency'
  | 'accountingYear'
  | 'enum';

export interface EconomicLogField {
  readonly name: string;
  readonly type: EconomicLogFieldType;
}

export type EconomicLogValue = string | number | readonly number[];

/** What a write tool call will change, resolved from its input before anything is sent. */
export interface EconomicChange {
  readonly tool: string;
  readonly action: EconomicChangeAction;
  readonly record: string;
  readonly booking: boolean;
  /**
   * The values of the tool's `logFields` that are present and have their
   * field's type (see EconomicLogFieldType), plus `lineCount` for tools that
   * take lines. A value of the wrong type is left out, so a name or a free
   * text can never reach the values.
   */
  readonly values: Readonly<Record<string, EconomicLogValue>>;
}

export type EconomicChangeResolution =
  | { readonly ok: true; readonly change: EconomicChange }
  | { readonly ok: false; readonly reason: string };

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

/** The input of the tools that create a sales document draft (invoice, quote, order). */
function salesDraftInput(noun: 'Invoice' | 'Quote' | 'Order') {
  return {
    type: 'object',
    required: ['customerNumber', 'lines'],
    properties: {
      customerNumber: { type: 'number', description: 'e-conomic customer number the draft is for.' },
      lines: {
        type: 'array',
        minItems: 1,
        description: `${noun} lines. e-conomic requires a product reference on each line.`,
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
      date: { type: 'string', description: `${noun} date (ISO 8601 date). Defaults to today.` },
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
}

const createDraftInvoiceInput = salesDraftInput('Invoice');
const createDraftQuoteInput = salesDraftInput('Quote');
const createDraftOrderInput = salesDraftInput('Order');

const upgradeQuoteInput = {
  type: 'object',
  required: ['quoteNumber', 'to'],
  properties: {
    quoteNumber: { type: 'integer', minimum: 1, description: 'The draft quote to upgrade.' },
    to: {
      type: 'string',
      enum: ['order', 'draftInvoice'],
      description: 'order: a draft order. draftInvoice: a draft invoice (not booked, not sent).',
    },
  },
  additionalProperties: false,
} satisfies GatewayJsonObject;

const upgradeOrderInput = {
  type: 'object',
  required: ['orderNumber'],
  properties: {
    orderNumber: { type: 'integer', minimum: 1, description: 'The draft order to turn into a draft invoice (not booked, not sent).' },
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
// a Projects-add-on employee, not a REST employee. Only the fields below are
// sent: there is no passthrough of other fields (with a broad app role it
// would reach any attribute e-conomic accepts).
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
    phone: { type: 'string' },
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
  },
  additionalProperties: false,
} satisfies GatewayJsonObject;

// Chart-of-accounts write (classic REST /accounts). Elevated: editing the CoA
// is a structural change, so this is risk 'destructive' and the hosting control
// plane gates it behind approval. accountType-specific required fields vary, so
// only the always-required keys are validated here and e-conomic validates on
// write. No other fields are sent.
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
  },
  required: ['accountNumber'],
  additionalProperties: false,
} satisfies GatewayJsonObject;

// Journal (kassekladde) lines on classic REST: POST /journals/{n}/vouchers
// creates one voucher with draft lines. Nothing is booked. Payment details
// (FI/giro numbers) on supplier invoices are not accepted: they come from the
// supplier record, and bank details are not changed through this server.
const MAX_JOURNAL_LINES = 50;
const ISO_DATE = String.raw`^\d{4}-\d{2}-\d{2}$`;

const journalVoucherFields = {
  journalNumber: { type: 'integer', minimum: 1, description: 'Journal (kassekladde) number.' },
  accountingYear: {
    type: 'string',
    description: 'Accounting year as e-conomic names it, e.g. 2026 or 2025/2026. Defaults to the year that contains the date.',
  },
  voucherNumber: {
    type: 'integer',
    minimum: 1,
    description: 'Voucher (bilag) number. Defaults to the next number in the journal.',
  },
} satisfies GatewayJsonObject;

const createJournalEntriesInput = {
  type: 'object',
  required: ['journalNumber', 'entries'],
  properties: {
    ...journalVoucherFields,
    entries: {
      type: 'array',
      minItems: 1,
      maxItems: MAX_JOURNAL_LINES,
      description: 'The voucher’s lines. Payments are registered with register_payment.',
      items: {
        type: 'object',
        required: ['type', 'date', 'amount'],
        properties: {
          type: {
            type: 'string',
            enum: ['financeVoucher', 'supplierInvoice'],
            description: 'financeVoucher: a ledger line (account against contra account). supplierInvoice: a purchase invoice from a supplier.',
          },
          date: { type: 'string', pattern: ISO_DATE, description: 'Entry date (YYYY-MM-DD).' },
          amount: {
            type: 'number',
            description: 'Amount with at most two decimals. The sign decides debit or credit, as in the e-conomic journal.',
          },
          text: { type: 'string', maxLength: 250, description: 'Entry text.' },
          accountNumber: { type: 'integer', minimum: 1, description: 'Ledger account. Required for financeVoucher.' },
          contraAccountNumber: { type: 'integer', minimum: 1, description: 'Contra ledger account, e.g. the bank account in the chart of accounts.' },
          vatCode: { type: 'string', maxLength: 5, description: 'VAT code for the account.' },
          contraVatCode: { type: 'string', maxLength: 5, description: 'VAT code for the contra account.' },
          currency: { type: 'string', pattern: '^[A-Z]{3}$', description: 'ISO 4217 currency code in capitals, e.g. DKK. Defaults to the base currency.' },
          supplierNumber: { type: 'integer', minimum: 1, description: 'Supplier. Required for supplierInvoice.' },
          supplierInvoiceNumber: { type: 'string', maxLength: 30, description: 'The supplier’s invoice number (supplierInvoice).' },
          dueDate: { type: 'string', pattern: ISO_DATE, description: 'Due date (supplierInvoice).' },
        },
        additionalProperties: false,
      },
    },
  },
  additionalProperties: false,
} satisfies GatewayJsonObject;

const registerPaymentInput = {
  type: 'object',
  required: ['journalNumber', 'kind', 'date', 'amount'],
  properties: {
    ...journalVoucherFields,
    kind: {
      type: 'string',
      enum: ['customerPayment', 'supplierPayment'],
      description: 'customerPayment: money received from a customer. supplierPayment: money paid to a supplier.',
    },
    date: { type: 'string', pattern: ISO_DATE, description: 'Payment date (YYYY-MM-DD).' },
    amount: {
      type: 'number',
      description: 'Amount with at most two decimals. The sign decides debit or credit, as in the e-conomic journal.',
    },
    customerNumber: { type: 'integer', minimum: 1, description: 'Customer who paid. Required for customerPayment.' },
    customerInvoiceNumber: { type: 'integer', minimum: 1, description: 'The booked invoice the payment settles (customerPayment).' },
    supplierNumber: { type: 'integer', minimum: 1, description: 'Supplier who is paid. Required for supplierPayment.' },
    supplierInvoiceNumber: { type: 'string', maxLength: 30, description: 'The supplier’s invoice number the payment settles (supplierPayment).' },
    contraAccountNumber: { type: 'integer', minimum: 1, description: 'Ledger account the money moves through, e.g. the bank account in the chart of accounts.' },
    currency: { type: 'string', pattern: '^[A-Z]{3}$', description: 'ISO 4217 currency code in capitals, e.g. DKK. Defaults to the base currency.' },
    text: { type: 'string', maxLength: 250, description: 'Entry text.' },
  },
  additionalProperties: false,
} satisfies GatewayJsonObject;

const bookJournalEntriesInput = {
  type: 'object',
  required: ['journalNumber'],
  properties: {
    journalNumber: { type: 'integer', minimum: 1, description: 'Journal (kassekladde) holding the draft entries.' },
    entryNumbers: {
      type: 'array',
      minItems: 1,
      maxItems: 25,
      items: { type: 'integer', minimum: 1 },
      description: 'Draft entry numbers to book (read them with accounting_entries, journals:draft-entries). Give entryNumbers or voucherNumbers.',
    },
    voucherNumbers: {
      type: 'array',
      minItems: 1,
      maxItems: 25,
      items: { type: 'integer', minimum: 1 },
      description: 'Book every draft line of these vouchers in the journal. Give entryNumbers or voucherNumbers.',
    },
    requireVoucher: {
      type: 'boolean',
      description: 'Require an attached document on every voucher (default true). Set false for lines without a document, e.g. bank payments.',
    },
  },
  additionalProperties: false,
} satisfies GatewayJsonObject;

const bookInvoiceInput = {
  type: 'object',
  required: ['draftInvoiceNumber'],
  properties: {
    draftInvoiceNumber: { type: 'integer', minimum: 1, description: 'The draft invoice to book.' },
  },
  additionalProperties: false,
} satisfies GatewayJsonObject;

const matchOpenItemsInput = {
  type: 'object',
  required: ['entryIds'],
  properties: {
    entryIds: {
      type: 'array',
      minItems: 2,
      maxItems: 100,
      items: { type: 'integer', minimum: 1 },
      description: 'Booked entry numbers to match against each other (same customer or supplier), e.g. a payment and the invoice it settles.',
    },
  },
  additionalProperties: false,
} satisfies GatewayJsonObject;

// Attached documents (bilag): documentsapi POST /AttachedDocuments, multipart.
// e-conomic accepts PDF, JPEG and PNG up to 9 MiB (x-max-file-upload-size-in-bytes).
const MAX_ATTACHMENT_BYTES = 9_437_184;
const ATTACHMENT_TYPES = {
  'application/pdf': { extension: 'pdf', magic: [0x25, 0x50, 0x44, 0x46] },
  'image/jpeg': { extension: 'jpg', magic: [0xff, 0xd8, 0xff] },
  'image/png': { extension: 'png', magic: [0x89, 0x50, 0x4e, 0x47] },
} as const;
/** The largest PDF get_document returns (base64 in the answer). */
const MAX_PDF_BYTES = 4 * 1024 * 1024;

const attachVoucherFileInput = {
  type: 'object',
  required: ['accountingYear', 'voucherNumber', 'fileBase64', 'contentType'],
  properties: {
    accountingYear: {
      type: 'string',
      pattern: String.raw`^\d{4}(\/\d{4})?$`,
      description: 'Accounting year of the voucher as e-conomic names it, e.g. 2026 or 2025/2026.',
    },
    voucherNumber: { type: 'integer', minimum: 1, maximum: 999999999, description: 'Voucher (bilag) number in a journal or among booked entries.' },
    fileBase64: { type: 'string', description: 'The file, base64-encoded. PDF, JPEG or PNG, at most 9 MB.' },
    contentType: { type: 'string', enum: Object.keys(ATTACHMENT_TYPES), description: 'The file type.' },
    onConflict: {
      type: 'string',
      enum: ['fail', 'merge'],
      description: 'When the voucher already has a document: fail (default) refuses, merge adds the file to it.',
    },
  },
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
 * lists are enforced before any request is sent; `economicToolCatalog` publishes
 * the requests they allow as `upstream`.
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
  quote_overview: [
    ref('rest', 'quotes/drafts'),
    ref('rest', 'quotes/sent'),
    ref('rest', 'quotes/archived'),
  ],
  order_overview: [
    ref('rest', 'orders/drafts'),
    ref('rest', 'orders/sent'),
    ref('rest', 'orders/archived'),
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
  get_document: [
    ref('documents', 'AttachedDocuments'),
    ref('rest', 'invoices/booked'),
    ref('rest', 'invoices/drafts'),
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

/** Narrow read tools that can fetch the PDF of one record (`pdf: true`). */
const PDF_TOOLS = new Set(['get_document']);

function narrowReadInput(targets: readonly EconomicResourceRef[], pdf = false): GatewayJsonObject {
  const [first] = targets;
  return {
    type: 'object',
    properties: {
      ...(pdf
        ? {
            pdf: {
              type: 'boolean',
              description: 'With number: return the record\u2019s PDF (base64, at most 4 MB) instead of its data.',
            },
          }
        : {}),
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
  /** Read tools: the targets enforced before any request. Empty for write tools. */
  reads: readonly EconomicResourceRef[];
  /** Write tools: the requests the tool makes. Read tools derive theirs from `reads`. */
  upstream?: readonly GatewayUpstreamOperation[];
  /** Booking tools: irreversible, run only when the host policy allows booking. */
  booking: boolean;
  /** Write tools: what the change does, for the host's log. */
  change?: EconomicChangeSpec;
}

function operation(
  access: 'read' | 'write',
  method: 'GET' | 'POST' | 'PUT',
  serviceId: string,
  resource: string,
  pathTemplate: string,
): GatewayUpstreamOperation {
  const service = findService(serviceId);
  const path = service.surface === 'rest' ? pathTemplate : `/${service.servicePath}${pathTemplate}`;
  return { access, method, path, serviceId, resource };
}

/** The GET requests a read target allows (collection, OpenAPI page, one record). */
function targetOperations(target: EconomicResourceRef): GatewayUpstreamOperation[] {
  if (target.serviceId === SELF.serviceId && target.resource === SELF.resource) {
    return [operation('read', 'GET', 'rest', 'self', '/self')];
  }
  const base = `/${target.resource}`;
  const service = findService(target.serviceId);
  const templates = service.surface === 'rest'
    ? [base, `${base}/{number}`]
    : [pagedPathTemplate(service, target.resource), base, `${base}/{number}`].filter((template): template is string => template !== undefined);
  return templates.map(template => operation('read', 'GET', target.serviceId, target.resource, template));
}

function upstreamOf(spec: ToolSpec): GatewayUpstreamOperation[] {
  if (spec.upstream) return [...spec.upstream];
  if (spec.broad) {
    // get_entity: a record by number, or any GET endpoint a self URL can match.
    return ENDPOINT_OPERATIONS
      .filter(endpoint => endpoint.method === 'GET')
      .map(endpoint =>
        operation(
          'read',
          'GET',
          endpoint.serviceId,
          resourceOfTemplate(endpoint.serviceId, endpoint.pathTemplate) ?? '',
          endpoint.pathTemplate,
        ),
      );
  }
  const reads = spec.reads.flatMap(targetOperations);
  if (!PDF_TOOLS.has(spec.name)) return reads;
  return [
    ...reads,
    ...spec.reads.map(target => operation('read', 'GET', target.serviceId, target.resource, `/${target.resource}/{number}/pdf`)),
  ];
}

function narrowReadTool(name: string, title: string, description: string): ToolSpec {
  const reads = NARROW_READ_TARGETS[name] ?? [];
  return {
    name,
    title,
    description,
    riskLevel: 'read',
    enabledByDefault: true,
    inputSchema: narrowReadInput(reads, PDF_TOOLS.has(name)),
    broad: false,
    reads,
    booking: false,
  };
}

function writeTool(
  spec: Omit<ToolSpec, 'riskLevel' | 'enabledByDefault' | 'broad' | 'reads' | 'booking' | 'change'> & {
    riskLevel?: GatewayRiskLevel;
    booking?: boolean;
    change: EconomicChangeSpec;
  },
): ToolSpec {
  return {
    ...spec,
    riskLevel: spec.riskLevel ?? 'write',
    enabledByDefault: false,
    broad: false,
    reads: [],
    booking: spec.booking === true,
  };
}

const change = (
  action: EconomicChangeAction,
  record: string,
  logFields: Record<string, EconomicLogFieldType>,
): EconomicChangeSpec => ({
  action,
  record,
  logFields: Object.entries(logFields).map(([name, type]) => ({ name, type })),
});

const WRITE_NOTE =
  'Write — disabled by default; enable via the gateway’s enableWrites option (standalone server: ECONOMIC_ENABLE_WRITES).';

const BOOKING_NOTE =
  'Booking — disabled by default; runs only when the host policy sets enableWrites and allowBooking.';

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
    booking: false,
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
    booking: false,
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
    booking: false,
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
    'Read products (default), product groups, price groups, prices in currencies, or units. Reads product resources only.',
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
    'quote_overview',
    'Get e-conomic quotes',
    'List draft quotes (default), sent quotes or archived quotes, or read one quote with its lines. Supports query paging (skippages, pagesize) and filters.',
  ),
  narrowReadTool(
    'order_overview',
    'Get e-conomic orders',
    'List draft orders (default), sent orders or archived orders, or read one order with its lines. Supports query paging (skippages, pagesize) and filters.',
  ),
  narrowReadTool(
    'project_overview',
    'Get e-conomic project overview',
    'Read the Projects add-on: projects (default), project groups and statuses, cost types, activities and activity groups, employees and employee groups, or time entries.',
  ),
  narrowReadTool(
    'get_document',
    'Get e-conomic documents and PDFs',
    'List attached documents (bilag) with voucher number and accounting year (default), or read one by its document number. With number and pdf: true, return the PDF of an attached document, a booked invoice or a draft invoice as base64 (at most 4 MB).',
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
    change: change('create', 'draft-invoice', { customerNumber: 'recordNumber', currency: 'currency', date: 'date' }),
    upstream: [
      operation('read', 'GET', 'rest', 'customers', '/customers/{number}'),
      operation('read', 'GET', 'rest', 'layouts', '/layouts'),
      operation('write', 'POST', 'rest', 'invoices/drafts', '/invoices/drafts'),
    ],
  }),
  writeTool({
    name: 'create_draft_quote',
    title: 'Create e-conomic draft quote',
    description: `Create a draft quote for a customer. The quote is not sent to the customer. ${WRITE_NOTE}`,
    inputSchema: createDraftQuoteInput,
    change: change('create', 'draft-quote', { customerNumber: 'recordNumber', currency: 'currency', date: 'date' }),
    upstream: [
      operation('read', 'GET', 'rest', 'customers', '/customers/{number}'),
      operation('read', 'GET', 'rest', 'layouts', '/layouts'),
      operation('write', 'POST', 'rest', 'quotes/drafts', '/quotes/drafts'),
    ],
  }),
  writeTool({
    name: 'create_draft_order',
    title: 'Create e-conomic draft order',
    description: `Create a draft order for a customer. The order is not sent to the customer. ${WRITE_NOTE}`,
    inputSchema: createDraftOrderInput,
    change: change('create', 'draft-order', { customerNumber: 'recordNumber', currency: 'currency', date: 'date' }),
    upstream: [
      operation('read', 'GET', 'rest', 'customers', '/customers/{number}'),
      operation('read', 'GET', 'rest', 'layouts', '/layouts'),
      operation('write', 'POST', 'rest', 'orders/drafts', '/orders/drafts'),
    ],
  }),
  writeTool({
    name: 'upgrade_quote',
    title: 'Turn an e-conomic quote into an order or draft invoice',
    description: `Turn a draft quote into a draft order or a draft invoice, with e-conomic's own upgrade template. Nothing is booked or sent. ${WRITE_NOTE}`,
    inputSchema: upgradeQuoteInput,
    change: change('create', 'upgraded-quote', { quoteNumber: 'recordNumber', to: 'enum' }),
    upstream: [
      operation('read', 'GET', 'rest', 'quotes/drafts', '/quotes/drafts/{number}/templates/upgrade-instructions/order'),
      operation('read', 'GET', 'rest', 'quotes/drafts', '/quotes/drafts/{number}/templates/upgrade-instructions/draftInvoice'),
      operation('write', 'POST', 'rest', 'orders/drafts', '/orders/drafts'),
      operation('write', 'POST', 'rest', 'invoices/drafts', '/invoices/drafts'),
    ],
  }),
  writeTool({
    name: 'upgrade_order',
    title: 'Turn an e-conomic order into a draft invoice',
    description: `Turn a draft order into a draft invoice, with e-conomic's own upgrade template. The invoice is not booked or sent; book it with book_invoice. ${WRITE_NOTE}`,
    inputSchema: upgradeOrderInput,
    change: change('create', 'upgraded-order', { orderNumber: 'recordNumber' }),
    upstream: [
      operation('read', 'GET', 'rest', 'orders/drafts', '/orders/drafts/{number}/templates/upgrade-instructions/draftInvoice'),
      operation('write', 'POST', 'rest', 'invoices/drafts', '/invoices/drafts'),
    ],
  }),
  writeTool({
    name: 'attach_voucher_file',
    title: 'Attach a document to an e-conomic voucher',
    description: `Attach a PDF, JPEG or PNG (at most 9 MB) to a voucher (bilag) of draft or booked entries, by voucher number and accounting year. When the voucher already has a document, the call fails unless onConflict is merge. Nothing is booked. ${WRITE_NOTE}`,
    inputSchema: attachVoucherFileInput,
    // The file and its name are never logged: only the voucher, the year and the type.
    change: change('create', 'attached-document', { voucherNumber: 'recordNumber', accountingYear: 'accountingYear', contentType: 'enum' }),
    upstream: [operation('write', 'POST', 'documents', 'AttachedDocuments', '/AttachedDocuments')],
  }),
  writeTool({
    name: 'upsert_customer',
    title: 'Create or update e-conomic customer',
    description: `Create a customer, or update an existing one by customerNumber (reads the current customer and merges the provided fields). ${WRITE_NOTE}`,
    inputSchema: upsertCustomerInput,
    change: change('upsert', 'customer', { customerNumber: 'recordNumber' }),
    upstream: [
      operation('read', 'GET', 'rest', 'customers', '/customers/{number}'),
      operation('write', 'POST', 'rest', 'customers', '/customers'),
      operation('write', 'PUT', 'rest', 'customers', '/customers/{number}'),
    ],
  }),
  writeTool({
    name: 'upsert_product',
    title: 'Create or update e-conomic product',
    description: `Create a product, or update it when the productNumber already exists (reads the current product and merges the provided fields). ${WRITE_NOTE}`,
    inputSchema: upsertProductInput,
    change: change('upsert', 'product', { productNumber: 'recordNumber' }),
    upstream: [
      operation('read', 'GET', 'rest', 'products', '/products/{number}'),
      operation('write', 'POST', 'rest', 'products', '/products'),
      operation('write', 'PUT', 'rest', 'products', '/products/{number}'),
    ],
  }),
  writeTool({
    name: 'upsert_project',
    title: 'Create or update e-conomic project',
    description: `Create a project in the Projects add-on, or update an existing one by projectNumber (reads the current project and merges the provided fields; upserts via the collection PUT). ${WRITE_NOTE}`,
    inputSchema: upsertProjectInput,
    change: change('upsert', 'project', { projectNumber: 'recordNumber', customerNumber: 'recordNumber' }),
    upstream: [
      operation('read', 'GET', 'projects', 'Projects', '/Projects/{number}'),
      operation('write', 'POST', 'projects', 'Projects', '/Projects'),
      operation('write', 'PUT', 'projects', 'Projects', '/Projects'),
    ],
  }),
  writeTool({
    name: 'create_time_entry',
    title: 'Register e-conomic project time',
    description: `Register a project time entry (hours on a project + activity for an employee, on a date). Create only; deletion is a separate operation. ${WRITE_NOTE}`,
    inputSchema: createTimeEntryInput,
    change: change('create', 'time-entry', {
      projectNumber: 'recordNumber',
      activityNumber: 'recordNumber',
      employeeNumber: 'recordNumber',
      date: 'date',
      hours: 'quantity',
    }),
    upstream: [operation('write', 'POST', 'projects', 'TimeEntries', '/TimeEntries')],
  }),
  writeTool({
    name: 'upsert_supplier',
    title: 'Create or update e-conomic supplier',
    description: `Create a supplier, or update an existing one by supplierNumber (reads the current supplier and merges the provided fields). Bank details (bank account, remittance advice, payment details) are never changed: such fields are refused. ${WRITE_NOTE}`,
    inputSchema: upsertSupplierInput,
    change: change('upsert', 'supplier', { supplierNumber: 'recordNumber' }),
    upstream: [
      operation('read', 'GET', 'rest', 'suppliers', '/suppliers/{number}'),
      operation('write', 'POST', 'rest', 'suppliers', '/suppliers'),
      operation('write', 'PUT', 'rest', 'suppliers', '/suppliers/{number}'),
    ],
  }),
  writeTool({
    name: 'upsert_employee',
    title: 'Create or update e-conomic project employee',
    description: `Create a Projects add-on employee, or update an existing one by employeeNumber (collection upsert, read-merge-write). ${WRITE_NOTE}`,
    inputSchema: upsertEmployeeInput,
    change: change('upsert', 'project-employee', { employeeNumber: 'recordNumber' }),
    upstream: [
      operation('read', 'GET', 'projects', 'Employees', '/Employees/{number}'),
      operation('write', 'POST', 'projects', 'Employees', '/Employees'),
      operation('write', 'PUT', 'projects', 'Employees', '/Employees'),
    ],
  }),
  writeTool({
    name: 'upsert_account',
    title: 'Create or update e-conomic ledger account',
    description: `Create a general-ledger account, or update an existing one by accountNumber (read-merge-write). Editing the chart of accounts is a structural change (risk destructive); a hosting control plane should gate it behind approval. ${WRITE_NOTE}`,
    riskLevel: 'destructive',
    inputSchema: upsertAccountInput,
    change: change('upsert', 'account', { accountNumber: 'recordNumber' }),
    upstream: [
      operation('read', 'GET', 'rest', 'accounts', '/accounts/{number}'),
      operation('write', 'POST', 'rest', 'accounts', '/accounts'),
      operation('write', 'PUT', 'rest', 'accounts', '/accounts/{number}'),
    ],
  }),
  writeTool({
    name: 'create_journal_entries',
    title: 'Create e-conomic journal entries',
    description: `Add one voucher with draft lines to a journal (kassekladde): ledger lines (account against contra account) or supplier invoices. The lines are not booked; book them with book_journal_entries. Payments are registered with register_payment. ${WRITE_NOTE}`,
    inputSchema: createJournalEntriesInput,
    change: change('create', 'journal-entry', { journalNumber: 'recordNumber', voucherNumber: 'recordNumber', accountingYear: 'accountingYear' }),
    upstream: [
      operation('read', 'GET', 'rest', 'accounting-years', '/accounting-years'),
      operation('write', 'POST', 'rest', 'journals', '/journals/{journalNumber}/vouchers'),
    ],
  }),
  writeTool({
    name: 'register_payment',
    title: 'Register e-conomic payment',
    description: `Register a payment as a draft line in a journal (kassekladde): money received from a customer, or money paid to a supplier, against an invoice. The line is not booked; book it with book_journal_entries. This records the payment in the accounts; it does not move money in the bank. ${WRITE_NOTE}`,
    inputSchema: registerPaymentInput,
    // supplierInvoiceNumber is the supplier's own free text: never logged.
    change: change('register', 'payment', {
      journalNumber: 'recordNumber',
      kind: 'enum',
      customerNumber: 'recordNumber',
      customerInvoiceNumber: 'recordNumber',
      supplierNumber: 'recordNumber',
      amount: 'amount',
      currency: 'currency',
      date: 'date',
    }),
    upstream: [
      operation('read', 'GET', 'rest', 'accounting-years', '/accounting-years'),
      operation('write', 'POST', 'rest', 'journals', '/journals/{journalNumber}/vouchers'),
    ],
  }),
  writeTool({
    name: 'book_journal_entries',
    title: 'Book e-conomic journal entries',
    description: `Book explicit draft entries of a journal (kassekladde), by entry numbers or by voucher numbers; never a whole journal. Every entry must exist in the journal, and every voucher must have an attached document unless requireVoucher is false. Booking is irreversible: corrections are made with counter-entries. ${BOOKING_NOTE}`,
    inputSchema: bookJournalEntriesInput,
    booking: true,
    change: change('book', 'journal-entry', { journalNumber: 'recordNumber', entryNumbers: 'numberList', voucherNumbers: 'numberList' }),
    upstream: [
      operation('read', 'GET', 'journals', 'draft-entries', '/draft-entries'),
      operation('read', 'GET', 'rest', 'accounting-years', '/accounting-years'),
      operation('read', 'GET', 'documents', 'AttachedDocuments', '/AttachedDocuments'),
      operation('write', 'POST', 'journals', 'journals', '/journals/{journalNumber}/bookdraftentries'),
    ],
  }),
  writeTool({
    name: 'book_invoice',
    title: 'Book e-conomic draft invoice',
    description: `Book a draft sales invoice, so it becomes a booked invoice with its own number and is posted to the ledger. It is not sent electronically (sendBy none). Booking is irreversible: corrections are made with a credit note. ${BOOKING_NOTE}`,
    inputSchema: bookInvoiceInput,
    booking: true,
    change: change('book', 'invoice', { draftInvoiceNumber: 'recordNumber' }),
    upstream: [
      operation('read', 'GET', 'rest', 'invoices/drafts', '/invoices/drafts/{number}'),
      operation('write', 'POST', 'rest', 'invoices/booked', '/invoices/booked'),
    ],
  }),
  writeTool({
    name: 'match_open_items',
    title: 'Match e-conomic open items',
    description: `Match (udligne) booked open items of one customer or supplier against each other, e.g. a payment against the invoice it settles. e-conomic has no way to undo a match through its API. ${BOOKING_NOTE}`,
    inputSchema: matchOpenItemsInput,
    booking: true,
    change: change('match', 'booked-entry', { entryIds: 'numberList' }),
    upstream: [operation('write', 'POST', 'booked-entries', 'booked-entries', '/booked-entries/match')],
  }),
];

const SPEC_BY_NAME = new Map(TOOL_SPECS.map(spec => [spec.name, spec]));

export { GATEWAY_FENCE, fenceRule, type FenceRule } from './economic/fence.js';

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
 * The tool catalog: every tool with its gateway definition and the e-conomic
 * API requests it may make. Generated from the same tool table as
 * `economicGatewayTools`, and deeply frozen. Hosts can use it to build their
 * own permission model without creating a gateway instance.
 */
export const economicToolCatalog: readonly GatewayToolCatalogEntry[] = deepFreeze(
  TOOL_SPECS.map(spec => {
    const defaultRead = spec.broad ? undefined : NARROW_READ_TARGETS[spec.name]?.[0];
    const entry: GatewayToolCatalogEntry = {
      name: spec.name,
      title: spec.title,
      description: spec.description,
      riskLevel: spec.riskLevel,
      enabledByDefault: spec.enabledByDefault,
      inputSchema: structuredClone(spec.inputSchema),
      upstream: upstreamOf(spec),
      broad: spec.broad,
      ...(defaultRead ? { defaultRead: { ...defaultRead } } : {}),
      booking: spec.booking,
      ...(spec.change ? { change: { ...spec.change, logFields: spec.change.logFields.map(field => ({ ...field })) } } : {}),
    };
    return entry;
  }),
);

/**
 * Write tools whose every write request is behind the fence, with the fence's reason: refused before anything else
 * (also in contract mode). Derived from the catalog, so a new tool is covered as soon as it is declared.
 */
const FENCED_TOOLS: ReadonlyMap<string, string> = new Map(
  economicToolCatalog.flatMap(entry => {
    const writes = entry.upstream.filter(operation => operation.access === 'write');
    const rules = writes.map(operation => fenceRule(operation.method, operation.path.replace(/\{[^}]+\}/g, '1')));
    return writes.length > 0 && rules.every(rule => rule !== undefined) ? [[entry.name, rules[0]!.reason] as const] : [];
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
  const service = findService(serviceId);
  const paged = Object.entries(service.pagedPaths ?? {}).find(([, template]) => template === pathTemplate);
  if (paged) return paged[0];
  const resources = [...service.resources].sort((a, b) => b.length - a.length);
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
  if (input.pdf !== undefined && typeof input.pdf !== 'boolean') return refuse('pdf must be true or false.');
  const pdf = input.pdf === true;
  if (pdf && numberValue === undefined) return refuse('pdf needs the number of the record.');

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
      if (!known) return refuse(`${serviceId.value.slice(0, 40)}:${resource.value.slice(0, 40)} is not a resource in the catalog.`);
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
    const pathTemplate = pdf
      ? `/${target.resource}/{number}/pdf`
      : resolveReadPathTemplate(target.serviceId, target.resource, {
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

const MAX_LOGGED_NUMBERS = 100;

/** The schema enum of an input field, for 'enum' log fields. */
function schemaEnum(spec: ToolSpec, field: string): readonly unknown[] {
  const properties = asObject(spec.inputSchema.properties);
  const values = asObject(properties[field]).enum;
  return Array.isArray(values) ? values : [];
}

/** A log field's value when it has exactly the field's type; otherwise nothing. */
function logValue(spec: ToolSpec, field: EconomicLogField, value: GatewayJsonValue | undefined): EconomicLogValue | undefined {
  switch (field.type) {
    case 'recordNumber':
      if (typeof value === 'number') return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
      return typeof value === 'string' && /^\d{1,15}$/.test(value) ? value : undefined;
    case 'numberList': {
      if (!Array.isArray(value) || value.length === 0 || value.length > MAX_LOGGED_NUMBERS) return undefined;
      const numbers = value.filter((item): item is number => typeof item === 'number' && Number.isSafeInteger(item) && item >= 1);
      return numbers.length === value.length ? numbers : undefined;
    }
    case 'amount':
      return typeof value === 'number' ? amountValue(value) : undefined;
    case 'quantity':
      return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
    case 'date':
      return isoDateValue(value);
    case 'currency':
      return isCurrencyCode(value) ? value : undefined;
    case 'accountingYear':
      return typeof value === 'string' && /^\d{4}(\/\d{4})?$/.test(value) ? value : undefined;
    case 'enum':
      return typeof value === 'string' && schemaEnum(spec, field.name).includes(value) ? value : undefined;
    default:
      return undefined;
  }
}

/**
 * Resolves what a write tool call will change, for a host that logs the
 * change before it is sent: the tool's action and record kind, and the values
 * of its `logFields` that are present and well-formed (see EconomicChange).
 * Refuses read tools, unknown tools and unknown input fields, as callTool does.
 * It does not validate the input further; callTool does that before sending.
 */
export function resolveEconomicChange(
  toolName: string,
  input: GatewayJsonObject = {},
): EconomicChangeResolution {
  const spec = typeof toolName === 'string' ? SPEC_BY_NAME.get(toolName) : undefined;
  if (!spec) return { ok: false, reason: `Unsupported e-conomic gateway tool: ${String(toolName).slice(0, 100)}` };
  if (!spec.change) return { ok: false, reason: `${spec.name} is not a write tool.` };
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { ok: false, reason: 'Input must be an object.' };
  const unknown = unknownInputFields(spec, input);
  if (unknown.length > 0) {
    return { ok: false, reason: `Unknown input field(s) for ${spec.name}: ${unknown.map(key => key.slice(0, 40)).join(', ')}.` };
  }
  const values: Record<string, EconomicLogValue> = {};
  for (const field of spec.change.logFields) {
    const value = logValue(spec, field, input[field.name]);
    if (value !== undefined) values[field.name] = value;
  }
  const lines = SALES_DRAFTS[spec.name] ? input.lines : spec.name === 'create_journal_entries' ? input.entries : undefined;
  if (Array.isArray(lines)) values.lineCount = lines.length;
  return {
    ok: true,
    change: { tool: spec.name, action: spec.change.action, record: spec.change.record, booking: spec.booking, values },
  };
}

/** The host policy of one gateway instance, checked and normalised. */
export interface ResolvedEconomicHostPolicy {
  readonly enableWrites: boolean;
  readonly allowBooking: boolean;
  readonly disabledTools: readonly string[];
  readonly allowedTools?: readonly string[];
}

function toolList(value: unknown, name: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some(entry => typeof entry !== 'string')) {
    throw new Error(`createEconomicGateway: policy.${name} must be an array of tool names.`);
  }
  const names = value.map(entry => (entry as string).trim()).filter(Boolean);
  for (const entry of names) {
    if (!SPEC_BY_NAME.has(entry)) {
      // The value is not echoed: configuration values are never quoted back.
      throw new Error(`createEconomicGateway: policy.${name} names an unknown tool.`);
    }
  }
  return [...new Set(names)];
}

function resolveHostPolicy(options: EconomicGatewayOptions): ResolvedEconomicHostPolicy {
  const policy = options.policy ?? {};
  if (policy === null || typeof policy !== 'object' || Array.isArray(policy)) {
    throw new Error('createEconomicGateway: policy must be an object.');
  }
  for (const key of ['enableWrites', 'allowBooking'] as const) {
    if (policy[key] !== undefined && typeof policy[key] !== 'boolean') {
      throw new Error(`createEconomicGateway: policy.${key} must be a boolean.`);
    }
  }
  if (options.enableWrites !== undefined && typeof options.enableWrites !== 'boolean') {
    throw new Error('createEconomicGateway: enableWrites must be a boolean.');
  }
  if (options.enableWrites !== undefined && policy.enableWrites !== undefined && options.enableWrites !== policy.enableWrites) {
    throw new Error('createEconomicGateway: enableWrites and policy.enableWrites disagree; give one of them.');
  }
  const enableWrites = (policy.enableWrites ?? options.enableWrites) === true;
  const allowBooking = policy.allowBooking === true;
  if (allowBooking && !enableWrites) {
    throw new Error('createEconomicGateway: policy.allowBooking requires enableWrites.');
  }
  const disabledTools = toolList(policy.disabledTools, 'disabledTools') ?? [];
  const allowedTools = toolList(policy.allowedTools, 'allowedTools');
  if (allowedTools !== undefined && allowedTools.length === 0) {
    // An empty allow-list would read as "no allow-list"; refuse it so a mistake cannot turn it off.
    throw new Error('createEconomicGateway: policy.allowedTools is empty; leave it out or list at least one tool.');
  }
  return Object.freeze({
    enableWrites,
    allowBooking,
    disabledTools: Object.freeze(disabledTools),
    ...(allowedTools ? { allowedTools: Object.freeze(allowedTools) } : {}),
  });
}

/** Why the host policy refuses a tool, or undefined when it is offered. */
function hostRefusal(policy: ResolvedEconomicHostPolicy, toolName: string): string | undefined {
  if (policy.disabledTools.includes(toolName) || (policy.allowedTools && !policy.allowedTools.includes(toolName))) {
    return `${toolName} is turned off by the host policy.`;
  }
  if (SPEC_BY_NAME.get(toolName)?.booking && !policy.allowBooking) {
    return `Write blocked by policy: booking disabled (${toolName} needs the host policy allowBooking).`;
  }
  return undefined;
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
  const more = total !== undefined && total > items.length;
  const records = (more ? total : items.length) === 1 ? 'record' : 'records';
  return more
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
    credentialEnv: {},
    // The fixed fence (GATEWAY_FENCE) applies to every request, whatever the policy.
    fence: true,
  };
  // Validates the base URLs at creation.
  new EconomicClient({ ...clientOptions, redactor: redactor.fork() });

  const hostPolicy = resolveHostPolicy(options);
  const writePolicy: EconomicPolicy = {
    ...basePolicy(),
    writesEnabled: hostPolicy.enableWrites,
    bookingEnabled: hostPolicy.allowBooking,
  };

  return {
    tools: economicGatewayTools.filter(tool => hostRefusal(hostPolicy, tool.name) === undefined),
    /** The host policy this instance runs under, as resolved at creation. */
    policy: hostPolicy,
    async callTool(
      toolName: string,
      input: GatewayJsonObject = {},
      context?: GatewayCallContext,
    ): Promise<GatewayToolResult> {
      const callRedactor = redactor.fork();
      // The call's token is known to the redactor from the start, so every answer below, early refusals included,
      // passes through the same redaction at the end.
      if (!contractMode) {
        callRedactor.add(callGrantToken(context, options.agreementGrantToken));
      }
      let result: GatewayToolResult;
      try {
        result = await (async (): Promise<GatewayToolResult> => {
          const spec = typeof toolName === 'string' ? SPEC_BY_NAME.get(toolName) : undefined;
          if (!spec) {
            return errorResult(`Unsupported e-conomic gateway tool: ${String(toolName).slice(0, 100)}`);
          }
          const args: GatewayJsonObject = input ?? {};
          if (typeof args !== 'object' || Array.isArray(args)) {
            return errorResult('Input must be an object.');
          }

          // The host's choice of tools and booking applies before anything else,
          // in contract mode too.
          const refused = hostRefusal(hostPolicy, spec.name);
          if (refused) {
            return errorResult(refused);
          }

          let target: EconomicReadTarget | undefined;
          if (spec.riskLevel === 'read') {
            const resolution = resolveEconomicReadTarget(spec.name, args);
            if (!resolution.ok) {
              return errorResult(resolution.reason);
            }
            target = resolution.target;
          } else {
            // Bank details are never changed, whatever the policy (also in contract mode).
            const bankFields = bankFieldPaths(args);
            if (bankFields.length > 0) {
              return errorResult(`Write blocked: ${BANK_FIELDS_REFUSED} Fields: ${bankFields.slice(0, 10).join(', ')}.`);
            }
            // Only the fields in the tool's schema are accepted; nothing is passed through.
            const unknown = unknownInputFields(spec, args);
            if (unknown.length > 0) {
              return errorResult(`Unknown input field(s) for ${spec.name}: ${unknown.map(key => key.slice(0, 40)).join(', ')}.`);
            }
          }

          // Refuse writes before any preparatory read (customer, layout, existing
          // record), and before a contract fixture: contract mode answers only
          // what live mode would allow. The full policy check still runs on the
          // built request.
          if (spec.riskLevel !== 'read' && !writePolicy.writesEnabled) {
            return errorResult('Write blocked by policy: writes disabled');
          }

          // A write tool whose every write is behind the fence (upsert_account) is refused here too, so contract
          // mode never answers a change that live mode would refuse.
          const fenced = FENCED_TOOLS.get(spec.name);
          if (fenced) {
            return errorResult(`Request blocked by the gateway fence (${fenced}).`);
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

          return target
            ? await readResult(client, spec.name, target, args)
            : await writeResult(client, spec.name, args, writePolicy);
        })();
      } catch (error) {
        result = errorResult(formatUnknownError(error, callRedactor));
      }
      // Defence in depth: a token in an answer (echoed by e-conomic, or in the input of an early refusal) never
      // reaches the caller.
      return redactResult(result, callRedactor);
    },
  };
}

/** A credential value; blank or whitespace-only counts as missing. */
/** One gateway instance, as returned by createEconomicGateway. */
export type EconomicGateway = ReturnType<typeof createEconomicGateway>;

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
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
  if (target.pathTemplate.endsWith('/{number}/pdf')) {
    const file = (await callEndpoint(client, {
      serviceId: target.serviceId,
      method: 'GET',
      pathTemplate: target.pathTemplate,
      pathParams: target.pathParams ? { ...target.pathParams } : undefined,
      binary: { maxBytes: MAX_PDF_BYTES },
    })) as EconomicBinaryBody;
    const kb = Math.max(1, Math.round(file.bytes.byteLength / 1024));
    return jsonResult(`${toolName}: PDF of one record from ${target.serviceId}:${target.resource} (${kb} KB).`, {
      contentType: file.contentType,
      sizeBytes: file.bytes.byteLength,
      base64: Buffer.from(file.bytes).toString('base64'),
    });
  }
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
    case 'create_draft_quote':
    case 'create_draft_order':
      return createSalesDraft(client, toolName, input, writePolicy);
    case 'upgrade_quote':
    case 'upgrade_order':
      return upgradeSalesDocument(client, toolName, input, writePolicy);
    case 'attach_voucher_file':
      return attachVoucherFile(client, input, writePolicy);
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
    case 'create_journal_entries':
      return createJournalEntries(client, input, writePolicy);
    case 'register_payment':
      return registerPayment(client, input, writePolicy);
    case 'book_journal_entries':
      return bookJournalEntries(client, input, writePolicy);
    case 'book_invoice':
      return bookInvoice(client, input, writePolicy);
    case 'match_open_items':
      return matchOpenItems(client, input, writePolicy);
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
    return jsonResult('e-conomic connection is available.', { connected: true });
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

/** The sales document drafts the gateway creates, by tool: the REST path and the answer's noun. */
const SALES_DRAFTS: Record<string, { path: '/invoices/drafts' | '/quotes/drafts' | '/orders/drafts'; noun: string }> = {
  create_draft_invoice: { path: '/invoices/drafts', noun: 'draft invoice' },
  create_draft_quote: { path: '/quotes/drafts', noun: 'draft quote' },
  create_draft_order: { path: '/orders/drafts', noun: 'draft order' },
};

async function createSalesDraft(
  client: EconomicClient,
  toolName: string,
  input: GatewayJsonObject,
  policy: EconomicPolicy,
): Promise<GatewayToolResult> {
  const kind = SALES_DRAFTS[toolName];
  if (!kind) {
    return errorResult(`Unsupported e-conomic gateway tool: ${toolName}`);
  }
  const customerNumber = numberValue(input.customerNumber);
  if (customerNumber === undefined) {
    return errorResult(`${toolName} requires a numeric customerNumber.`);
  }

  const rawLines = Array.isArray(input.lines) ? input.lines : [];
  if (rawLines.length === 0) {
    return errorResult(`${toolName} requires at least one line.`);
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
    capability: toolName,
    method: 'POST',
    path: kind.path,
    body,
  });
  if (denied) {
    return denied;
  }

  const created = await callEndpoint(client, {
    serviceId: 'rest',
    method: 'POST',
    pathTemplate: kind.path,
    body,
    idempotencyKey: stringValue(input.idempotencyKey),
  });

  return jsonResult(`Created e-conomic ${kind.noun}.`, created);
}

/**
 * Turns a draft quote into a draft order or draft invoice, or a draft order
 * into a draft invoice: reads e-conomic's upgrade template for the document
 * and POSTs it, as e-conomic documents. Nothing is booked or sent.
 */
async function upgradeSalesDocument(
  client: EconomicClient,
  toolName: string,
  input: GatewayJsonObject,
  policy: EconomicPolicy,
): Promise<GatewayToolResult> {
  const fromQuote = toolName === 'upgrade_quote';
  const number = positiveInteger(fromQuote ? input.quoteNumber : input.orderNumber);
  if (number === undefined) {
    return errorResult(`${toolName} needs ${fromQuote ? 'quoteNumber' : 'orderNumber'} (a positive whole number).`);
  }
  let to: 'order' | 'draftInvoice' = 'draftInvoice';
  if (fromQuote) {
    if (input.to !== 'order' && input.to !== 'draftInvoice') return errorResult('to must be order or draftInvoice.');
    to = input.to;
  }
  const source = fromQuote ? 'quotes' : 'orders';
  const sourceNoun = fromQuote ? 'quote' : 'order';
  const targetPath = to === 'order' ? '/orders/drafts' : '/invoices/drafts';

  // Check the policy before the template is read, so a refused write reads nothing.
  const early = writePolicyDenial(policy, { capability: toolName, method: 'POST', path: targetPath, body: {} });
  if (early) return early;

  let template: unknown;
  try {
    template = await callEndpoint(client, {
      serviceId: 'rest',
      method: 'GET',
      pathTemplate: `/${source}/drafts/{number}/templates/upgrade-instructions/${to}`,
      pathParams: { number },
    });
  } catch (error) {
    if (error instanceof EconomicHttpError && error.status === 404) {
      return errorResult(`Draft ${sourceNoun} ${number} does not exist.`);
    }
    throw error;
  }
  const body = asObject(template)[to];
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return errorResult(`e-conomic returned no upgrade template for draft ${sourceNoun} ${number}.`);
  }

  const denied = writePolicyDenial(policy, { capability: toolName, method: 'POST', path: targetPath, body });
  if (denied) return denied;

  const created = await callEndpoint(client, { serviceId: 'rest', method: 'POST', pathTemplate: targetPath, body });
  const createdNumber = to === 'order' ? asObject(created).orderNumber : asObject(created).draftInvoiceNumber;
  const what = to === 'order' ? 'draft order' : 'draft invoice';
  return jsonResult(
    `Turned draft ${sourceNoun} ${number} into ${what}${typeof createdNumber === 'number' ? ` ${createdNumber}` : ''}. Not booked or sent.`,
    created,
  );
}

/** Strict base64 (no whitespace, correct padding), decoded. */
function decodeBase64Strict(value: string): Uint8Array | undefined {
  if (value.length === 0 || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return undefined;
  return new Uint8Array(Buffer.from(value, 'base64'));
}

/** A multipart/form-data body with text fields and one file. */
function multipartBody(
  fields: Record<string, string>,
  file: { field: string; name: string; contentType: string; bytes: Uint8Array },
): { body: Uint8Array; contentType: string } {
  const boundary = `----letmcpGateway${crypto.randomUUID().replace(/-/g, '')}`;
  const encoder = new TextEncoder();
  const parts: Uint8Array[] = [];
  for (const [name, value] of Object.entries(fields)) {
    parts.push(encoder.encode(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`));
  }
  parts.push(
    encoder.encode(
      `--${boundary}\r\nContent-Disposition: form-data; name="${file.field}"; filename="${file.name}"\r\nContent-Type: ${file.contentType}\r\n\r\n`,
    ),
    file.bytes,
    encoder.encode(`\r\n--${boundary}--\r\n`),
  );
  return { body: new Uint8Array(Buffer.concat(parts)), contentType: `multipart/form-data; boundary=${boundary}` };
}

/**
 * Attaches a file to a voucher (documentsapi POST /AttachedDocuments). The
 * file is checked (type by its first bytes, size) before anything is sent; it
 * is never logged or echoed.
 */
async function attachVoucherFile(
  client: EconomicClient,
  input: GatewayJsonObject,
  policy: EconomicPolicy,
): Promise<GatewayToolResult> {
  const voucherNumber = positiveInteger(input.voucherNumber);
  if (voucherNumber === undefined || voucherNumber > 999999999) {
    return errorResult('attach_voucher_file needs voucherNumber (a positive whole number).');
  }
  const year = typeof input.accountingYear === 'string' ? input.accountingYear.trim() : '';
  if (!/^\d{4}(\/\d{4})?$/.test(year)) {
    return errorResult('accountingYear must be written as e-conomic names it, e.g. 2026 or 2025/2026.');
  }
  const contentType = typeof input.contentType === 'string' ? input.contentType : '';
  const type = Object.hasOwn(ATTACHMENT_TYPES, contentType) ? ATTACHMENT_TYPES[contentType as keyof typeof ATTACHMENT_TYPES] : undefined;
  if (!type) return errorResult('contentType must be application/pdf, image/jpeg or image/png.');
  if (input.onConflict !== undefined && input.onConflict !== 'fail' && input.onConflict !== 'merge') {
    return errorResult('onConflict must be fail or merge.');
  }
  if (typeof input.fileBase64 !== 'string' || input.fileBase64.length > Math.ceil(MAX_ATTACHMENT_BYTES / 3) * 4) {
    return errorResult('fileBase64 must be a base64 string of at most 9 MB.');
  }
  const bytes = decodeBase64Strict(input.fileBase64);
  if (!bytes || bytes.byteLength === 0) return errorResult('fileBase64 is not valid base64.');
  if (bytes.byteLength > MAX_ATTACHMENT_BYTES) return errorResult('The file is larger than 9 MB.');
  if (!type.magic.every((byte, index) => bytes[index] === byte)) {
    return errorResult(`The file is not a ${type.extension.toUpperCase()} (its first bytes do not match ${contentType}).`);
  }

  const denied = writePolicyDenial(policy, {
    capability: 'attach_voucher_file',
    serviceId: 'documents',
    method: 'POST',
    path: '/AttachedDocuments',
    body: { voucherNumber, accountingYear: year },
  });
  if (denied) return denied;

  const form = multipartBody(
    { VoucherNumber: String(voucherNumber), AccountingYear: year, OnConflict: input.onConflict === 'merge' ? 'Merge' : 'Fail' },
    { field: 'File', name: `bilag-${voucherNumber}.${type.extension}`, contentType, bytes },
  );
  const created = await callEndpoint(client, {
    serviceId: 'documents',
    method: 'POST',
    pathTemplate: '/AttachedDocuments',
    rawBody: form.body,
    rawContentType: form.contentType,
  });
  return jsonResult(`Attached a ${type.extension.toUpperCase()} to voucher ${voucherNumber} in ${year}.`, created ?? { voucherNumber, accountingYear: year });
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
    current: existing,
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
    current: existing,
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
  'phone',
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

    const body: GatewayJsonObject = { ...flat };
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

  const body: GatewayJsonObject = { ...existing, ...flat };
  applyRefs(body);

  const denied = writePolicyDenial(policy, {
    capability: 'upsert_supplier',
    method: 'PUT',
    path: `/suppliers/${supplierNumber}`,
    body,
    current: existing,
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

  if (employeeNumber === undefined) {
    if (!flat.name) {
      return errorResult('Creating an employee requires a name.');
    }

    const body: GatewayJsonObject = { ...flat };
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

  const body: GatewayJsonObject = { ...existing, ...flat, employeeNumber };
  const denied = writePolicyDenial(policy, {
    capability: 'upsert_employee',
    serviceId: 'projects',
    method: 'PUT',
    path: '/Employees',
    body,
    current: existing,
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

    const body: GatewayJsonObject = { ...flat, accountNumber };
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

  const body: GatewayJsonObject = { ...existing, ...flat };
  const denied = writePolicyDenial(policy, {
    capability: 'upsert_account',
    method: 'PUT',
    path: `/accounts/${accountNumber}`,
    body,
    current: existing,
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

/**
 * The checks every gateway write passes right before it is sent: the built-in
 * write policy (with the host's writes and booking settings), and the bank
 * guard. `current` is the record a read-merge-write update replaces: then only
 * a bank field that would change is refused; without it, any bank field in
 * the body is.
 */
function writePolicyDenial(
  policy: EconomicPolicy,
  input: {
    capability: string;
    method: 'POST' | 'PUT';
    path: string;
    body?: unknown;
    serviceId?: string;
    current?: unknown;
  },
): GatewayToolResult | undefined {
  const decision = checkPolicy({
    capability: input.capability,
    serviceId: input.serviceId ?? 'rest',
    method: input.method,
    path: input.path,
    body: input.body,
  }, policy);
  if (!decision.allowed) {
    return errorResult(`Write blocked by policy: ${decision.reason}`);
  }

  const bankFields = input.current === undefined
    ? bankFieldPaths(input.body)
    : changedBankFields(input.current, input.body);
  if (bankFields.length > 0) {
    return errorResult(`Write blocked: ${BANK_FIELDS_REFUSED} Fields: ${bankFields.slice(0, 10).join(', ')}.`);
  }
  return undefined;
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

    const body: GatewayJsonObject = { ...flat };
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

  const body: GatewayJsonObject = { ...existing, ...flat, projectNumber };
  applyRefs(body);

  const denied = writePolicyDenial(policy, {
    capability: 'upsert_project',
    serviceId: 'projects',
    method: 'PUT',
    path: '/Projects',
    body,
    current: existing,
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

  const body: GatewayJsonObject = {
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

type JournalEntryKind = 'financeVouchers' | 'supplierInvoices' | 'customerPayments' | 'supplierPayments';

function positiveInteger(value: GatewayJsonValue | undefined): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1 ? value : undefined;
}

function positiveIntegerList(value: GatewayJsonValue | undefined, max: number): number[] | undefined {
  if (!Array.isArray(value) || value.length === 0 || value.length > max) return undefined;
  const numbers = value.map(item => positiveInteger(item));
  return numbers.every((item): item is number => item !== undefined) ? [...new Set(numbers)] : undefined;
}

function isoDateValue(value: GatewayJsonValue | undefined): string | undefined {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return undefined;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value ? value : undefined;
}

/** An amount with at most two decimals, not zero. */
function amountValue(value: GatewayJsonValue | undefined): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value === 0) return undefined;
  return Math.abs(value * 100 - Math.round(value * 100)) < 1e-6 ? value : undefined;
}

/**
 * ISO 4217 codes, from the runtime's own list (Intl), written in capitals as
 * ISO writes them. A three-letter word such as a first name is not a code, and
 * lower case is refused rather than upper-cased, so a name like "Bob" never
 * becomes "BOB".
 */
const CURRENCY_CODES: ReadonlySet<string> = new Set(Intl.supportedValuesOf('currency'));

function isCurrencyCode(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Z]{3}$/.test(value) && CURRENCY_CODES.has(value);
}

function currencyValue(value: GatewayJsonValue | undefined): { ok: true; value?: string } | { ok: false } {
  if (value === undefined) return { ok: true };
  return isCurrencyCode(value) ? { ok: true, value } : { ok: false };
}

function shortText(value: GatewayJsonValue | undefined, max: number): { ok: true; value?: string } | { ok: false } {
  if (value === undefined) return { ok: true };
  if (typeof value !== 'string' || value.length > max) return { ok: false };
  const trimmed = value.trim();
  return trimmed ? { ok: true, value: trimmed } : { ok: true };
}

/** The fields every journal line shares: date, amount, text, contra account, currency. */
function commonJournalFields(source: GatewayJsonObject, label: string): { line: GatewayJsonObject } | { error: string } {
  const date = isoDateValue(source.date);
  if (!date) return { error: `${label} needs a date (YYYY-MM-DD).` };
  const amount = amountValue(source.amount);
  if (amount === undefined) return { error: `${label} needs a non-zero amount with at most two decimals.` };
  const text = shortText(source.text, 250);
  if (!text.ok) return { error: `${label}: text must be at most 250 characters.` };
  const currency = currencyValue(source.currency);
  if (!currency.ok) return { error: `${label}: currency must be a three-letter code.` };
  const line: GatewayJsonObject = { date, amount };
  if (text.value) line.text = text.value;
  if (currency.value) line.currency = { code: currency.value };
  if (source.contraAccountNumber !== undefined) {
    const contra = positiveInteger(source.contraAccountNumber);
    if (contra === undefined) return { error: `${label}: contraAccountNumber must be a positive whole number.` };
    line.contraAccount = { accountNumber: contra };
  }
  return { line };
}

function journalLine(source: GatewayJsonObject, index: number): { kind: JournalEntryKind; line: GatewayJsonObject } | { error: string } {
  const label = `Line ${index + 1}`;
  const known = Object.keys(createJournalEntriesInput.properties.entries.items.properties);
  const unknown = Object.keys(source).filter(key => !known.includes(key));
  if (unknown.length > 0) {
    return { error: `${label}: unknown field(s) ${unknown.map(key => key.slice(0, 40)).join(', ')}.` };
  }
  const common = commonJournalFields(source, label);
  if ('error' in common) return common;
  const line = common.line;
  if (source.type === 'financeVoucher') {
    for (const field of ['supplierNumber', 'supplierInvoiceNumber', 'dueDate'] as const) {
      if (source[field] !== undefined) return { error: `${label}: ${field} belongs on a supplierInvoice line.` };
    }
    const account = positiveInteger(source.accountNumber);
    if (account === undefined) return { error: `${label}: a financeVoucher line needs accountNumber.` };
    line.account = { accountNumber: account };
    for (const [field, target] of [['vatCode', 'vatAccount'], ['contraVatCode', 'contraVatAccount']] as const) {
      const code = shortText(source[field], 5);
      if (!code.ok) return { error: `${label}: ${field} must be at most 5 characters.` };
      if (code.value) line[target] = { vatCode: code.value };
    }
    return { kind: 'financeVouchers', line };
  }
  if (source.type === 'supplierInvoice') {
    for (const field of ['accountNumber', 'vatCode'] as const) {
      if (source[field] !== undefined) return { error: `${label}: ${field} belongs on a financeVoucher line.` };
    }
    const supplier = positiveInteger(source.supplierNumber);
    if (supplier === undefined) return { error: `${label}: a supplierInvoice line needs supplierNumber.` };
    line.supplier = { supplierNumber: supplier };
    const invoice = shortText(source.supplierInvoiceNumber, 30);
    if (!invoice.ok) return { error: `${label}: supplierInvoiceNumber must be at most 30 characters.` };
    if (invoice.value) line.supplierInvoiceNumber = invoice.value;
    if (source.dueDate !== undefined) {
      const due = isoDateValue(source.dueDate);
      if (!due) return { error: `${label}: dueDate must be a date (YYYY-MM-DD).` };
      line.dueDate = due;
    }
    const contraVat = shortText(source.contraVatCode, 5);
    if (!contraVat.ok) return { error: `${label}: contraVatCode must be at most 5 characters.` };
    if (contraVat.value) line.contraVatAccount = { vatCode: contraVat.value };
    return { kind: 'supplierInvoices', line };
  }
  return { error: `${label}: type must be financeVoucher or supplierInvoice.` };
}

interface AccountingYear {
  year?: string;
  fromDate?: string;
  toDate?: string;
}

/** The accounting year that holds every date, from GET /accounting-years. */
async function accountingYearFor(client: EconomicClient, dates: string[]): Promise<string | { error: string }> {
  const response = (await callEndpoint(client, {
    serviceId: 'rest',
    method: 'GET',
    pathTemplate: '/accounting-years',
    query: { pagesize: 1000 },
  })) as { collection?: AccountingYear[] };
  const years = Array.isArray(response?.collection) ? response.collection : [];
  const yearOf = (date: string) =>
    years.find(year => typeof year.fromDate === 'string' && typeof year.toDate === 'string'
      && year.fromDate.slice(0, 10) <= date && date <= year.toDate.slice(0, 10))?.year;
  const found = new Set(dates.map(yearOf));
  if (found.has(undefined)) return { error: 'No accounting year in e-conomic holds the date; give accountingYear or create the year first.' };
  if (found.size > 1) return { error: 'The lines fall in more than one accounting year; add them as separate vouchers.' };
  return [...found][0] as string;
}

/** Posts one voucher with draft lines to a journal (classic REST). Nothing is booked. */
async function postJournalVoucher(
  client: EconomicClient,
  policy: EconomicPolicy,
  capability: string,
  input: GatewayJsonObject,
  lines: Array<{ kind: JournalEntryKind; line: GatewayJsonObject }>,
): Promise<GatewayToolResult> {
  const journalNumber = positiveInteger(input.journalNumber);
  if (journalNumber === undefined) return errorResult(`${capability} needs journalNumber (a positive whole number).`);
  const voucherNumber = input.voucherNumber === undefined ? undefined : positiveInteger(input.voucherNumber);
  if (input.voucherNumber !== undefined && voucherNumber === undefined) {
    return errorResult('voucherNumber must be a positive whole number.');
  }
  const givenYear = shortText(input.accountingYear, 20);
  if (!givenYear.ok || (givenYear.value !== undefined && !/^\d{4}(\/\d{4})?[a-z]?$/.test(givenYear.value))) {
    return errorResult('accountingYear must be written as e-conomic names it, e.g. 2026 or 2025/2026.');
  }

  // Check policy before the preparatory read, so a refused write reads nothing.
  const path = `/journals/${journalNumber}/vouchers`;
  const early = writePolicyDenial(policy, { capability, method: 'POST', path, body: {} });
  if (early) return early;

  let year = givenYear.value;
  if (year === undefined) {
    const resolved = await accountingYearFor(client, lines.map(item => String(item.line.date)));
    if (typeof resolved !== 'string') return errorResult(resolved.error);
    year = resolved;
  }

  const entries: Record<string, GatewayJsonObject[]> = {};
  for (const { kind, line } of lines) {
    (entries[kind] ??= []).push(line);
  }
  const body: GatewayJsonObject = {
    accountingYear: { year },
    journal: { journalNumber },
    entries,
    ...(voucherNumber === undefined ? {} : { voucherNumber }),
  };
  const denied = writePolicyDenial(policy, { capability, method: 'POST', path, body });
  if (denied) return denied;

  const created = await callEndpoint(client, {
    serviceId: 'rest',
    method: 'POST',
    pathTemplate: '/journals/{journalNumber}/vouchers',
    pathParams: { journalNumber },
    body,
  });
  const first = Array.isArray(created) ? created[0] : created;
  const number = asObject(first).voucherNumber;
  const where = `journal ${journalNumber}${typeof number === 'number' ? `, voucher ${number}` : ''}`;
  const count = lines.length === 1 ? '1 draft line' : `${lines.length} draft lines`;
  return jsonResult(`Added ${count} to ${where}. Not booked.`, created);
}

async function createJournalEntries(
  client: EconomicClient,
  input: GatewayJsonObject,
  policy: EconomicPolicy,
): Promise<GatewayToolResult> {
  const raw = Array.isArray(input.entries) ? input.entries : [];
  if (raw.length === 0 || raw.length > MAX_JOURNAL_LINES) {
    return errorResult(`create_journal_entries needs 1-${MAX_JOURNAL_LINES} entries.`);
  }
  const lines: Array<{ kind: JournalEntryKind; line: GatewayJsonObject }> = [];
  for (let index = 0; index < raw.length; index += 1) {
    const source = objectValue(raw[index]);
    if (!source) return errorResult(`Line ${index + 1} must be an object.`);
    const built = journalLine(source, index);
    if ('error' in built) return errorResult(built.error);
    lines.push(built);
  }
  return postJournalVoucher(client, policy, 'create_journal_entries', input, lines);
}

async function registerPayment(
  client: EconomicClient,
  input: GatewayJsonObject,
  policy: EconomicPolicy,
): Promise<GatewayToolResult> {
  const common = commonJournalFields(input, 'The payment');
  if ('error' in common) return errorResult(common.error);
  const line = common.line;
  if (input.kind === 'customerPayment') {
    if (input.supplierNumber !== undefined || input.supplierInvoiceNumber !== undefined) {
      return errorResult('A customerPayment takes customerNumber and customerInvoiceNumber, not supplier fields.');
    }
    const customer = positiveInteger(input.customerNumber);
    if (customer === undefined) return errorResult('A customerPayment needs customerNumber.');
    line.customer = { customerNumber: customer };
    if (input.customerInvoiceNumber !== undefined) {
      const invoice = positiveInteger(input.customerInvoiceNumber);
      if (invoice === undefined) return errorResult('customerInvoiceNumber must be a positive whole number.');
      line.customerInvoice = invoice;
    }
    return postJournalVoucher(client, policy, 'register_payment', input, [{ kind: 'customerPayments', line }]);
  }
  if (input.kind === 'supplierPayment') {
    if (input.customerNumber !== undefined || input.customerInvoiceNumber !== undefined) {
      return errorResult('A supplierPayment takes supplierNumber and supplierInvoiceNumber, not customer fields.');
    }
    const supplier = positiveInteger(input.supplierNumber);
    if (supplier === undefined) return errorResult('A supplierPayment needs supplierNumber.');
    line.supplier = { supplierNumber: supplier };
    const invoice = shortText(input.supplierInvoiceNumber, 30);
    if (!invoice.ok) return errorResult('supplierInvoiceNumber must be at most 30 characters.');
    if (invoice.value) line.supplierInvoiceNumber = invoice.value;
    return postJournalVoucher(client, policy, 'register_payment', input, [{ kind: 'supplierPayments', line }]);
  }
  return errorResult('kind must be customerPayment or supplierPayment.');
}

/**
 * Books explicit draft entries (journalsapi POST /journals/{n}/bookdraftentries)
 * with the same guardrails as the standalone server's booking: every entry
 * exists in the journal, and every voucher has an attached document unless
 * requireVoucher is false.
 */
async function bookJournalEntries(
  client: EconomicClient,
  input: GatewayJsonObject,
  policy: EconomicPolicy,
): Promise<GatewayToolResult> {
  const journalNumber = positiveInteger(input.journalNumber);
  if (journalNumber === undefined) return errorResult('book_journal_entries needs journalNumber (a positive whole number).');
  const hasEntries = input.entryNumbers !== undefined;
  const hasVouchers = input.voucherNumbers !== undefined;
  if (hasEntries === hasVouchers) return errorResult('Give entryNumbers or voucherNumbers (one of them).');
  const listed = positiveIntegerList(hasEntries ? input.entryNumbers : input.voucherNumbers, 25);
  if (!listed) return errorResult(`${hasEntries ? 'entryNumbers' : 'voucherNumbers'} must be 1-25 positive whole numbers.`);
  if (input.requireVoucher !== undefined && typeof input.requireVoucher !== 'boolean') {
    return errorResult('requireVoucher must be true or false.');
  }
  const requireVoucher = input.requireVoucher !== false;

  const path = `/journals/${journalNumber}/bookdraftentries`;
  // Booking must be allowed before anything is read.
  const early = writePolicyDenial(policy, { capability: 'book_journal_entries', serviceId: 'journals', method: 'POST', path, body: {} });
  if (early) return early;

  const entryNumbers = hasEntries ? listed : await draftEntryNumbersForVouchers(client, journalNumber, listed);
  const validation = await validateBooking(client, { journalNumber, entryNumbers, requireVoucher }, {});
  const body: GatewayJsonObject = { entryNumbers: validation.entries.map(entry => entry.entryNumber) };
  const denied = writePolicyDenial(policy, { capability: 'book_journal_entries', serviceId: 'journals', method: 'POST', path, body });
  if (denied) return denied;

  const booked = await callEndpoint(client, {
    serviceId: 'journals',
    method: 'POST',
    pathTemplate: '/journals/{journalNumber}/bookdraftentries',
    pathParams: { journalNumber },
    body,
  });
  const count = validation.entries.length === 1 ? '1 entry' : `${validation.entries.length} entries`;
  return jsonResult(`Booked ${count} in journal ${journalNumber}.`, { validation, result: booked ?? null });
}

/** Books a draft invoice (REST POST /invoices/booked). Never sent electronically from here. */
async function bookInvoice(
  client: EconomicClient,
  input: GatewayJsonObject,
  policy: EconomicPolicy,
): Promise<GatewayToolResult> {
  const draftInvoiceNumber = positiveInteger(input.draftInvoiceNumber);
  if (draftInvoiceNumber === undefined) return errorResult('book_invoice needs draftInvoiceNumber (a positive whole number).');
  const body: GatewayJsonObject = { draftInvoice: { draftInvoiceNumber }, sendBy: 'none' };
  // Booking must be allowed before anything is read.
  const denied = writePolicyDenial(policy, { capability: 'book_invoice', method: 'POST', path: '/invoices/booked', body });
  if (denied) return denied;

  try {
    await callEndpoint(client, {
      serviceId: 'rest',
      method: 'GET',
      pathTemplate: '/invoices/drafts/{number}',
      pathParams: { number: draftInvoiceNumber },
    });
  } catch (error) {
    if (error instanceof EconomicHttpError && error.status === 404) {
      return errorResult(`Draft invoice ${draftInvoiceNumber} does not exist (already booked or deleted?).`);
    }
    throw error;
  }

  const booked = await callEndpoint(client, {
    serviceId: 'rest',
    method: 'POST',
    pathTemplate: '/invoices/booked',
    body,
  });
  const number = asObject(booked).bookedInvoiceNumber;
  return jsonResult(
    `Booked draft invoice ${draftInvoiceNumber}${typeof number === 'number' ? ` as invoice ${number}` : ''}. Not sent electronically.`,
    booked,
  );
}

/** Matches booked open items (bookedEntriesapi POST /booked-entries/match). No API undo exists. */
async function matchOpenItems(
  client: EconomicClient,
  input: GatewayJsonObject,
  policy: EconomicPolicy,
): Promise<GatewayToolResult> {
  const raw = Array.isArray(input.entryIds) ? input.entryIds : [];
  const entryIds = positiveIntegerList(raw, 100);
  if (!entryIds || entryIds.length !== raw.length) {
    return errorResult('entryIds must contain 2-100 unique booked entry numbers.');
  }
  assertMatchEntryIds(entryIds);
  const body: GatewayJsonObject = { entryIds };
  const denied = writePolicyDenial(policy, {
    capability: 'match_open_items',
    serviceId: 'booked-entries',
    method: 'POST',
    path: '/booked-entries/match',
    body,
  });
  if (denied) return denied;

  const matched = await callEndpoint(client, {
    serviceId: 'booked-entries',
    method: 'POST',
    pathTemplate: '/booked-entries/match',
    body,
  });
  return jsonResult(`Matched ${entryIds.length} booked entries.`, matched ?? null);
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

/**
 * A successful result: the summary line, then the same data as compact JSON in the
 * text block, as the MCP spec asks of a tool that returns structured content. Many
 * clients read only the text block. The text carries exactly `structuredContent`.
 */
function jsonResult(text: string, structuredContent: unknown): GatewayToolResult {
  const data = toGatewayJson(structuredContent);
  return {
    content: [{ type: 'text', text: `${text}\n\n${JSON.stringify(data)}` }],
    structuredContent: data,
  };
}

/** The result with every string (text and structured content) passed through the redactor. */
function redactResult(result: GatewayToolResult, redactor: SecretRedactor): GatewayToolResult {
  if (result.structuredContent === undefined) {
    return { ...result, content: result.content.map(block => ({ ...block, text: redactor.redact(block.text) })) };
  }
  // The data is redacted as data, and the text block's JSON is written again from it, so the text stays valid JSON
  // and exactly the structured content (a pattern match on serialized JSON could eat a closing quote).
  const structuredContent = redactJson(result.structuredContent, redactor);
  const original = JSON.stringify(result.structuredContent);
  const content = result.content.map(block => {
    const separator = block.text.lastIndexOf(`\n\n${original}`);
    if (separator !== -1 && separator + 2 + original.length === block.text.length) {
      return { ...block, text: `${redactor.redact(block.text.slice(0, separator))}\n\n${JSON.stringify(structuredContent)}` };
    }
    return { ...block, text: redactor.redact(block.text) };
  });
  return { ...result, content, structuredContent };
}

function redactJson(value: GatewayJsonValue, redactor: SecretRedactor): GatewayJsonValue {
  if (typeof value === 'string') return redactor.redact(value);
  if (Array.isArray(value)) return value.map(item => redactJson(item, redactor));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, nested]) => [redactor.redact(key), redactJson(nested, redactor)]));
  }
  return value;
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
