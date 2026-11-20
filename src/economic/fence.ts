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

export const GATEWAY_FENCE: readonly FenceRule[] = Object.freeze([
  {
    methods: ['DELETE'],
    pattern: /./,
    reason: 'deletion (no gateway tool deletes anything)',
  },
  {
    methods: '*',
    pattern: /(^|\/)(delete|deletebulk)(\/|$)/i,
    reason: 'deletion (no gateway tool deletes anything)',
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
    reason: 'booking a whole journal (only explicit entries are booked)',
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
