import { readFileSync } from 'node:fs';
import type { HttpMethod } from './client.js';

export interface EconomicPolicy {
  writesEnabled: boolean;
  /**
   * Gates the curated booking capabilities (economic_prepare_booking /
   * economic_prepare_open_item_match + economic_commit_booking). Booking and
   * matching are irreversible in e-conomic; the raw endpoint paths stay
   * denied for every other capability regardless of this flag.
   */
  bookingEnabled: boolean;
  allowedCapabilities: string[];
  allowedServices: string[];
  allowedMethods: HttpMethod[];
  deniedPathPatterns: string[];
  maxAmount?: number;
}

export interface PolicyDecision {
  allowed: boolean;
  reason: string;
  policy: EconomicPolicy;
}

export interface PolicyCheckInput {
  capability: string;
  serviceId: string;
  method: HttpMethod;
  path: string;
  body?: unknown;
}

export function loadPolicy(): EconomicPolicy {
  const base: EconomicPolicy = {
    writesEnabled: process.env.ECONOMIC_ENABLE_WRITES === 'true',
    bookingEnabled: process.env.ECONOMIC_ENABLE_BOOKING === 'true',
    allowedCapabilities: [],
    allowedServices: [],
    allowedMethods: ['POST', 'PUT', 'PATCH'],
    deniedPathPatterns: [
      '/journals/.*/book',
      '/entries/draft/.*/book',
      '/booked-entries/match',
      // Classic REST books a draft invoice by POSTing it to /invoices/booked —
      // booking is irreversible, so it is denied alongside the journal book paths.
      '/invoices/booked',
      '/webhooks',
      '/vat',
      '/payment',
    ],
  };

  const policyPath = process.env.ECONOMIC_POLICY_PATH;
  if (!policyPath) {
    return base;
  }

  const parsed = JSON.parse(readFileSync(policyPath, 'utf8')) as Partial<EconomicPolicy>;
  return {
    ...base,
    ...parsed,
    writesEnabled: parsed.writesEnabled ?? base.writesEnabled,
    bookingEnabled: parsed.bookingEnabled ?? base.bookingEnabled,
    allowedCapabilities: parsed.allowedCapabilities ?? base.allowedCapabilities,
    allowedServices: parsed.allowedServices ?? base.allowedServices,
    allowedMethods: parsed.allowedMethods ?? base.allowedMethods,
    deniedPathPatterns: parsed.deniedPathPatterns ?? base.deniedPathPatterns,
  };
}

export function isMutation(method: HttpMethod): boolean {
  return method !== 'GET';
}

/** Exact endpoints each booking capability may target — nothing else. */
const BOOKING_CAPABILITY_PATHS: Record<string, RegExp> = {
  economic_prepare_booking: /^\/journals\/(\{journalNumber\}|\d+)\/bookdraftentries$/,
  economic_prepare_open_item_match: /^\/booked-entries\/match$/,
};

export function isBookingCapability(capability: string): boolean {
  return capability in BOOKING_CAPABILITY_PATHS;
}

export function checkPolicy(input: PolicyCheckInput, policy = loadPolicy()): PolicyDecision {
  if (!isMutation(input.method)) {
    return { allowed: true, reason: 'read operation', policy };
  }

  if (!policy.writesEnabled) {
    return { allowed: false, reason: 'writes disabled', policy };
  }

  // Curated booking capabilities: allowed only on their exact endpoint and
  // only when booking is explicitly enabled. They bypass deniedPathPatterns
  // (which exist to keep booking paths out of reach of everything else) but
  // still run the amount check below via the ordinary flow in prepareBooking.
  const bookingPattern = BOOKING_CAPABILITY_PATHS[input.capability];
  if (bookingPattern) {
    if (!bookingPattern.test(input.path)) {
      return { allowed: false, reason: `booking capability used outside its endpoint: ${input.path}`, policy };
    }
    if (!policy.bookingEnabled) {
      return { allowed: false, reason: 'booking disabled (ECONOMIC_ENABLE_BOOKING)', policy };
    }
    return { allowed: true, reason: 'booking capability enabled by policy', policy };
  }

  if (
    policy.allowedCapabilities.length > 0 &&
    !policy.allowedCapabilities.includes(input.capability)
  ) {
    return { allowed: false, reason: `capability not allowed: ${input.capability}`, policy };
  }

  if (policy.allowedServices.length > 0 && !policy.allowedServices.includes(input.serviceId)) {
    return { allowed: false, reason: `service not allowed: ${input.serviceId}`, policy };
  }

  if (!policy.allowedMethods.includes(input.method)) {
    return { allowed: false, reason: `method not allowed: ${input.method}`, policy };
  }

  if (policy.deniedPathPatterns.some(pattern => new RegExp(pattern, 'i').test(input.path))) {
    return { allowed: false, reason: `path denied by policy: ${input.path}`, policy };
  }

  if (policy.maxAmount !== undefined && bodyContainsAmountAbove(input.body, policy.maxAmount)) {
    return { allowed: false, reason: `amount exceeds policy maxAmount ${policy.maxAmount}`, policy };
  }

  return { allowed: true, reason: 'matched write policy', policy };
}

function bodyContainsAmountAbove(value: unknown, maxAmount: number): boolean {
  if (typeof value === 'number') {
    return Math.abs(value) > maxAmount;
  }

  if (Array.isArray(value)) {
    return value.some(item => bodyContainsAmountAbove(item, maxAmount));
  }

  if (typeof value !== 'object' || value === null) {
    return false;
  }

  return Object.entries(value).some(([key, nested]) => {
    if (/amount|total|price/i.test(key) && typeof nested === 'number') {
      return Math.abs(nested) > maxAmount;
    }

    return bodyContainsAmountAbove(nested, maxAmount);
  });
}
