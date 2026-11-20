import type { HttpMethod } from './client.js';

/**
 * The gateway's fixed fence: requests the embedded gateway never sends,
 * whatever the host policy, the tool or the app's role at e-conomic. With a
 * broad app role (SuperUser) an agreement grant reaches every path below, so
 * the fence sits in the HTTP client, right before `fetch`, and applies to every
 * request a gateway client makes, reads included where a rule says so.
 *
 * The standalone server does not use the fence (its raw endpoint tool has its
 * own policy, and its time-entry tool may delete a registration).
 *
 * DELETE is refused on every path but the few in `GATEWAY_DELETABLE`.
 *
 * Rules are matched case-insensitively against the request path relative to
 * the base URL: `/self/company/bankinformation` on the REST API, and
 * `/<servicePath>/<path>` on the OpenAPI host, e.g.
 * `/journalsapi/v15.0.0/journals/5/book`.
 */
export interface FenceRule {
  /** Methods the rule refuses; `'*'` refuses every method. */
  readonly methods: readonly HttpMethod[] | '*';
  readonly pattern: RegExp;
  /** Why the path is fenced, for the refusal message. */
  readonly reason: string;
}

const WRITES: readonly HttpMethod[] = ['POST', 'PUT', 'PATCH', 'DELETE'];

/**
 * The only paths a DELETE may reach: one record that has had no effect outside
 * e-conomic yet. A draft journal entry (journalsapi), a draft invoice (classic
 * REST), and a project time entry (projectsapi). The gateway's
 * delete tools read the record's status right before the DELETE and refuse
 * anything booked, sent, approved or reconciled; the fence only keeps every
 * other path out of reach. Matched against the lower-cased, decoded path.
 */
export const GATEWAY_DELETABLE: readonly RegExp[] = Object.freeze([
  /^\/journalsapi\/v\d+(\.\d+)*\/draft-entries\/\d+$/,
  /^\/invoices\/drafts\/\d+$/,
  /^\/projectsapi\/v\d+(\.\d+)*\/timeentries\/\d+$/,
]);

const NOT_DELETABLE = new RegExp(`^(?!(${GATEWAY_DELETABLE.map(pattern => pattern.source).join('|')})).`);

export const GATEWAY_FENCE: readonly FenceRule[] = Object.freeze([
  {
    methods: ['DELETE'],
    pattern: NOT_DELETABLE,
    reason: 'deletion (only a draft journal entry, a draft invoice or a time entry can be deleted)',
  },
  {
    methods: '*',
    pattern: /(^|\/)(delete|deletebulk)(\/|$)/i,
    reason: 'bulk deletion',
  },
  {
    methods: WRITES,
    pattern: /(^|\/)self(\/|$)/i,
    reason: "the company's own record, bank information, users and settings",
  },
  {
    methods: WRITES,
    pattern: /bank/i,
    reason: 'bank information',
  },
  {
    methods: WRITES,
    pattern: /(^|\/)(users?|app-roles|agreements?|settings)(\/|$)/i,
    reason: 'users, access and settings',
  },
  {
    methods: WRITES,
    pattern: /\/webhooks/i,
    reason: 'webhooks',
  },
  {
    methods: WRITES,
    pattern: /(^|\/)(book|bookwithdateinterval)(\/|$)/i,
    reason: 'booking whatever a journal holds at the time (only entries that were read and checked are booked)',
  },
  {
    methods: WRITES,
    pattern: /(^|\/)accounting-?years(\/|$)/i,
    reason: 'accounting years',
  },
  {
    methods: WRITES,
    pattern: /(^|\/)accounts(\/|$)/i,
    reason: 'the chart of accounts',
  },
] satisfies FenceRule[]);

/** The rule that fences a request, or undefined when it may be sent. */
export function fenceRule(method: HttpMethod, path: string): FenceRule | undefined {
  const normalized = normalizeFencePath(path);
  return GATEWAY_FENCE.find(
    rule => (rule.methods === '*' || rule.methods.includes(method)) && rule.pattern.test(normalized),
  );
}

/**
 * Lower-cases the path and decodes percent-escapes, so `/Self`, `/%73elf`
 * and `/journals/5/Book` meet the same rules. A path that cannot be decoded
 * is matched as given.
 */
export function normalizeFencePath(path: string): string {
  let decoded = path;
  try {
    decoded = decodeURIComponent(path);
  } catch {
    // keep the raw path
  }
  return decoded.toLowerCase();
}

/** Thrown before a fenced request is sent. Carries no credential. */
export class EconomicFenceError extends Error {
  constructor(method: HttpMethod, path: string, rule: FenceRule) {
    super(`Request blocked by the gateway fence (${rule.reason}): ${method} ${path.slice(0, 200)}`);
    this.name = 'EconomicFenceError';
  }
}
