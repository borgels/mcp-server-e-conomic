import { readFileSync } from 'node:fs';
import type { HttpMethod } from './client.js';

export interface EconomicPolicy {
  writesEnabled: boolean;
  /**
   * Gates the curated booking capabilities (economic_prepare_booking /
   * economic_prepare_open_item_match + economic_commit_booking, and the
   * gateway's book_journal, book_journal_entries, book_invoice, approve_time_entries
   * and match_open_items). Booking and
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

/** The built-in policy with writes and booking off. Reads no environment. */
export function basePolicy(): EconomicPolicy {
  return {
    writesEnabled: false,
    bookingEnabled: false,
    allowedCapabilities: [],
    allowedServices: [],
    allowedMethods: ['POST', 'PUT', 'PATCH'],
    deniedPathPatterns: [
      '/journals/.*/book',
      '/entries/draft/.*/book',
      '/booked-entries/match',
      // Approving time books its cost on the project and cannot be undone: only
      // the curated approve_time_entries tool reaches it, with booking enabled.
      '/TimeEntries/approve',
      // Classic REST books a draft invoice by POSTing it to /invoices/booked —
      // booking is irreversible, so it is denied alongside the journal book paths.
      '/invoices/booked',
      '/webhooks',
      '/vat',
      '/payment',
      // The company's own record (name, address, bank details) is never written.
      '^/self(/|$)',
    ],
  };
}

/** The standalone server's policy: the built-in policy plus ECONOMIC_* environment settings. */
export function loadPolicy(): EconomicPolicy {
  const base: EconomicPolicy = {
    ...basePolicy(),
    writesEnabled: process.env.ECONOMIC_ENABLE_WRITES === 'true',
    bookingEnabled: process.env.ECONOMIC_ENABLE_BOOKING === 'true',
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

/**
 * Exact endpoints each booking capability may target — nothing else. The
 * economic_prepare_* names are the standalone server's; the others are the
 * embedded gateway's booking tools (see gateway.ts), whose `bookingEnabled`
 * comes from the host policy's `allowBooking`.
 */
const BOOKING_CAPABILITY_PATHS: Record<string, RegExp> = {
  economic_prepare_booking: /^\/journals\/(\{journalNumber\}|\d+)\/bookdraftentries$/,
  economic_prepare_open_item_match: /^\/booked-entries\/match$/,
  book_journal_entries: /^\/journals\/(\{journalNumber\}|\d+)\/bookdraftentries$/,
  book_journal: /^\/journals\/(\{journalNumber\}|\d+)\/bookdraftentries$/,
  match_open_items: /^\/booked-entries\/match$/,
  book_invoice: /^\/invoices\/booked$/,
  approve_time_entries: /^\/TimeEntries\/approve$/,
};

export function isBookingCapability(capability: string): boolean {
  return capability in BOOKING_CAPABILITY_PATHS;
}

/**
 * The embedded gateway's delete tools and the one endpoint each may target.
 * They delete a record that has had no effect outside e-conomic (a draft, or a
 * time entry that is neither approved nor reconciled); the tool reads its
 * status right before the DELETE. Any other DELETE goes through the ordinary
 * checks (DELETE is not in the default allowedMethods), and the gateway's fixed
 * fence refuses every other DELETE path whatever the policy says.
 */
const DELETE_CAPABILITY_PATHS: Record<string, RegExp> = {
  delete_journal_entry: /^\/draft-entries\/(\{number\}|\d+)$/,
  delete_draft_invoice: /^\/invoices\/drafts\/(\{number\}|\d+)$/,
  delete_draft_quote: /^\/quotes\/drafts\/(\{number\}|\d+)$/,
  delete_draft_order: /^\/orders\/drafts\/(\{number\}|\d+)$/,
  delete_time_entry: /^\/TimeEntries\/(\{number\}|\d+)$/,
};

export function checkPolicy(rawInput: PolicyCheckInput, policy = loadPolicy()): PolicyDecision {
  // Defence in depth: callers pass the catalog's spelling, but a path without
  // the leading "/" must never slip past an anchored or slash-led pattern.
  const trimmed = String(rawInput.path ?? '').trim();
  const input = { ...rawInput, path: trimmed.startsWith('/') ? trimmed : `/${trimmed}` };
  if (!isMutation(input.method)) {
    return { allowed: true, reason: 'read operation', policy };
  }

  if (!policy.writesEnabled) {
    return { allowed: false, reason: 'writes disabled', policy };
  }

  // The gateway's delete tools: DELETE on their one endpoint, nothing else.
  const deletePattern = DELETE_CAPABILITY_PATHS[input.capability];
  if (deletePattern) {
    if (input.method !== 'DELETE' || !deletePattern.test(input.path)) {
      return { allowed: false, reason: `deletion not allowed: ${input.method} ${input.path}`, policy };
    }
    return { allowed: true, reason: 'deletion of a draft allowed by its tool', policy };
  }

  // Curated booking capabilities: allowed only on their exact endpoint and
  // only when booking is explicitly enabled. They bypass deniedPathPatterns
  // (which exist to keep booking paths out of reach of everything else). The
  // per-entry maxAmount, entry and voucher checks are not done here: they run
  // in bookings.ts both at prepare and again at commit
  // (revalidateBookingOperation), since the request body only carries entry
  // numbers, not amounts.
  const bookingPattern = BOOKING_CAPABILITY_PATHS[input.capability];
  if (bookingPattern) {
    if (!bookingPattern.test(input.path)) {
      return { allowed: false, reason: `booking capability used outside its endpoint: ${input.path}`, policy };
    }
    if (!policy.bookingEnabled) {
      return { allowed: false, reason: 'booking disabled (ECONOMIC_ENABLE_BOOKING, or the gateway host policy allowBooking)', policy };
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
