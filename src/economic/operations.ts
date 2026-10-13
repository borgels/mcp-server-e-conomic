import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { HttpMethod, QueryValue } from './client.js';
import { findEndpoint } from './catalog.js';
import { assertCapabilityRoute } from './capabilities.js';
import { materializePath } from './endpoints.js';
import { normalizeJsonBody } from './json.js';
import { checkPolicy, type PolicyDecision } from './policy.js';

export interface BookingGuards {
  /** Whether attached-document checks run for the entries' vouchers. */
  requireVoucher: boolean;
}

export interface PreparedOperation {
  capability: string;
  serviceId: string;
  method: HttpMethod;
  pathTemplate: string;
  pathParams?: Record<string, string | number>;
  query?: Record<string, QueryValue>;
  body?: unknown;
  dryRun: true;
  reason: string;
  bookingGuards?: BookingGuards;
  preparedAt: string;
  expiresAt: string;
  /** HMAC-SHA256 (server secret) over every field except itself and policyDecision. */
  operationHash: string;
  /** Advisory only; commit always re-evaluates policy. Not covered by the signature. */
  policyDecision: PolicyDecision;
}

export interface PrepareOperationInput {
  capability: string;
  serviceId: string;
  method: HttpMethod;
  pathTemplate: string;
  pathParams?: Record<string, string | number>;
  query?: Record<string, QueryValue>;
  body?: unknown;
  reason: string;
  bookingGuards?: BookingGuards;
}

export const PREPARED_OPERATION_TTL_MS = 15 * 60 * 1000;

// Used when ECONOMIC_PREPARE_SECRET is not set: prepared operations are then
// only valid within this process (they do not survive a restart).
const processSecret = randomBytes(32);

function secret(): Buffer {
  const configured = process.env.ECONOMIC_PREPARE_SECRET;
  return configured ? Buffer.from(configured, 'utf8') : processSecret;
}

export function prepareOperation(input: PrepareOperationInput, now = new Date()): PreparedOperation {
  assertCapabilityRoute(input.capability, input);
  const endpoint = findEndpoint(input.serviceId, input.method, input.pathTemplate);
  const path = materializePath(endpoint, input.pathParams);
  const body = normalizeJsonBody(input.body);
  const policyDecision = checkPolicy({
    capability: input.capability,
    serviceId: input.serviceId,
    method: input.method,
    path,
    body,
  });
  const unsigned = {
    capability: input.capability,
    serviceId: input.serviceId,
    method: input.method,
    pathTemplate: endpoint.pathTemplate,
    pathParams: input.pathParams,
    query: input.query,
    body,
    dryRun: true as const,
    reason: input.reason,
    bookingGuards: input.bookingGuards,
    preparedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + PREPARED_OPERATION_TTL_MS).toISOString(),
  };

  return {
    ...unsigned,
    operationHash: sign(unsigned),
    policyDecision,
  };
}

/**
 * Verifies that the operation was prepared (and signed) by this server, is
 * unexpired, and still targets a route its capability owns. Returns the
 * operation with its body normalized back to an object/array, in case the
 * round trip through the MCP client re-stringified it. Callers must use the
 * returned operation (not the input) for policy checks and dispatch, and must
 * ignore the caller-supplied policyDecision.
 */
export function verifyPreparedOperation(
  operation: PreparedOperation,
  options: { confirmOperationHash?: string; now?: Date } = {},
): PreparedOperation {
  const body = normalizeJsonBody(operation.body);
  const unsigned = {
    capability: operation.capability,
    serviceId: operation.serviceId,
    method: operation.method,
    pathTemplate: operation.pathTemplate,
    pathParams: operation.pathParams,
    query: operation.query,
    body,
    dryRun: operation.dryRun,
    reason: operation.reason,
    bookingGuards: operation.bookingGuards,
    preparedAt: operation.preparedAt,
    expiresAt: operation.expiresAt,
  };

  const expected = Buffer.from(sign(unsigned), 'hex');
  const given = Buffer.from(String(operation.operationHash ?? ''), 'hex');
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) {
    throw new Error(
      'Prepared operation signature does not match; it was altered or prepared by another server instance. Prepare it again.',
    );
  }

  if (options.confirmOperationHash !== undefined && options.confirmOperationHash !== operation.operationHash) {
    throw new Error('confirmOperationHash must equal operation.operationHash.');
  }

  const expiresAt = Date.parse(String(operation.expiresAt));
  if (!Number.isFinite(expiresAt) || (options.now ?? new Date()).getTime() > expiresAt) {
    throw new Error('Prepared operation has expired (15 minutes); prepare it again.');
  }

  assertCapabilityRoute(operation.capability, operation);

  return { ...operation, body };
}

function sign(value: unknown): string {
  return createHmac('sha256', secret()).update(stableStringify(value)).digest('hex');
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(item => stableStringify(item)).join(',')}]`;
  }

  if (value && typeof value === 'object') {
    return `{${Object.entries(value)
      .filter(([, nested]) => nested !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, nested]) => `${JSON.stringify(key)}:${stableStringify(nested)}`)
      .join(',')}}`;
  }

  return JSON.stringify(value);
}
