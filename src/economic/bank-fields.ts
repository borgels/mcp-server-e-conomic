import type { EconomicClient, HttpMethod } from './client.js';
import { callEndpoint, canonicalEndpointCall } from './endpoints.js';

/**
 * Bank details are never changed through this server: a false account number
 * on a supplier (or on the company) is the classic payment fraud, so the
 * change belongs in e-conomic itself, by a person.
 *
 * e-conomic's field names for bank details (classic REST schemas):
 *   suppliers          bankAccount, remittanceAdvice { creditorId, paymentType }
 *   journal entries    paymentDetails on supplier invoices (FI/giro numbers, OCR lines)
 *   company (/self)    bankInformation { bankName, bankSortCode, bankAccountNumber, bankGiroNumber }
 * plus the usual words for the same thing (IBAN, SWIFT/BIC, registration number).
 *
 * `costAccount { accountNumber }` on a supplier is a ledger account, not a
 * bank account, so a bare `accountNumber` key is not a bank field.
 */
const BANK_KEY =
  /bank|iban|swift|^bic$|giro|creditor|remittance|paymentdetails|paymenttype|fisupplier|ocrline|sortcode|regnr|registrationnumber/i;

export function isBankFieldName(key: string): boolean {
  return BANK_KEY.test(key);
}

/** The paths of every bank field in a value (recursively), e.g. `remittanceAdvice.creditorId`. */
export function bankFieldPaths(value: unknown, prefix = ''): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => bankFieldPaths(item, `${prefix}[${index}]`));
  }
  if (!value || typeof value !== 'object') {
    return [];
  }
  return Object.entries(value as Record<string, unknown>).flatMap(([key, nested]) => {
    const path = prefix ? `${prefix}.${key}` : key;
    return isBankFieldName(key) ? [path] : bankFieldPaths(nested, path);
  });
}

/**
 * The bank fields whose value differs between the current record and the body
 * that would replace it (a field that is added, removed or changed). Used for
 * read-merge-write updates, where the body carries the current bank details
 * unchanged.
 */
export function changedBankFields(current: unknown, next: unknown): string[] {
  const before = bankValues(current);
  const after = bankValues(next);
  const keys = new Set([...before.keys(), ...after.keys()]);
  return [...keys].filter(key => before.get(key) !== after.get(key)).sort();
}

function bankValues(value: unknown): Map<string, string> {
  const values = new Map<string, string>();
  const source = value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  for (const [key, nested] of Object.entries(source)) {
    if (isBankFieldName(key)) values.set(key, stableJson(nested));
  }
  return values;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, nested]) => nested !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, nested]) => `${JSON.stringify(key)}:${stableJson(nested)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

export const BANK_FIELDS_REFUSED =
  'Bank details (bank account, IBAN, SWIFT/BIC, registration number, payment details) are not changed through this server; change them in e-conomic itself.';

/**
 * The write guard both surfaces share (gateway write tools, the standalone
 * commit and endpoint tools): a write whose body carries bank fields is
 * refused, before it is sent. The one exception is the read-merge-write
 * update of a supplier (`PUT /suppliers/{number}`), whose body carries the
 * supplier's current bank details: there the current supplier is read and the
 * write is refused when any bank field would differ.
 */
export async function assertNoBankChange(
  client: EconomicClient,
  call: {
    serviceId: string;
    method: HttpMethod;
    pathTemplate: string;
    pathParams?: Record<string, string | number>;
    body?: unknown;
  },
): Promise<void> {
  if (call.method === 'GET') return;
  // Compare on the catalog's spelling: "suppliers/{number}" is the same endpoint.
  const canonical = canonicalEndpointCall({ ...call, pathTemplate: call.pathTemplate }).call;
  call = { ...call, serviceId: canonical.serviceId, pathTemplate: canonical.pathTemplate };
  const isSupplierUpdate = call.serviceId === 'rest' && call.method === 'PUT' && call.pathTemplate === '/suppliers/{number}';
  if (!isSupplierUpdate) {
    const fields = bankFieldPaths(call.body);
    if (fields.length > 0) {
      throw new Error(`Write blocked: ${BANK_FIELDS_REFUSED} Fields: ${fields.slice(0, 10).join(', ')}.`);
    }
    return;
  }
  const current = await callEndpoint(client, {
    serviceId: 'rest',
    method: 'GET',
    pathTemplate: '/suppliers/{number}',
    pathParams: call.pathParams,
  });
  const changed = changedBankFields(current, call.body);
  if (changed.length > 0) {
    throw new Error(`Write blocked: ${BANK_FIELDS_REFUSED} Fields: ${changed.join(', ')}.`);
  }
}
