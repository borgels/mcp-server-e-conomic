const SECRET_PATTERNS = [
  /X-AppSecretToken:\s*[^,\s}]+/gi,
  /X-AgreementGrantToken:\s*[^,\s}]+/gi,
  /(appSecretToken|agreementGrantToken|ECONOMIC_APP_SECRET_TOKEN|ECONOMIC_AGREEMENT_GRANT_TOKEN)["']?\s*[:=]\s*["']?[^"',\s}]+/gi,
];

export interface EconomicErrorPayload {
  message?: string;
  error?: string;
  errors?: unknown[];
  logId?: string;
  [key: string]: unknown;
}

export class EconomicHttpError extends Error {
  readonly status: number;
  readonly method: string;
  readonly url: string;
  readonly payload?: EconomicErrorPayload | unknown;
  readonly retryAfter?: string;
  readonly logId?: string;
  /**
   * e-conomic's own id for the request, from a response header, only in the form such ids have (see requestIdFrom).
   * Not part of the message.
   */
  readonly requestId?: string;

  constructor(input: {
    status: number;
    method: string;
    url: string;
    payload?: EconomicErrorPayload | unknown;
    retryAfter?: string;
    fallbackMessage?: string;
    redactor?: SecretRedactor;
    requestId?: string;
  }) {
    super(formatEconomicHttpError(input));
    this.name = 'EconomicHttpError';
    this.status = input.status;
    this.method = input.method;
    this.url = redactSecrets(input.url, input.redactor);
    this.payload = input.payload;
    this.retryAfter = input.retryAfter;
    this.logId = isEconomicErrorPayload(input.payload) ? input.payload.logId : undefined;
    this.requestId = vendorRequestId(input.requestId);
  }
}

/**
 * Response headers that carry the vendor's own id for a request, most specific first. Add the vendor's documented
 * header in front when it has one.
 */
export const REQUEST_ID_HEADERS: readonly string[] = [
  'x-request-id',
  'request-id',
  'x-correlation-id',
  'correlation-id',
  'x-ms-request-id',
  'x-amzn-requestid',
];

/**
 * A hex id: one run of hex digits, or groups of at least four hex digits joined by single hyphens (a UUID is one),
 * 8 to 64 characters in all. A name, a sentence or an e-mail address never fits.
 */
const REQUEST_ID_FORM = /^[0-9A-Fa-f]{4,}(?:-[0-9A-Fa-f]{4,})*$/;
/** Six digits and four more: the shape of a Danish personal number. An id that holds it is dropped. */
const PERSONAL_NUMBER_SHAPE = /\d{6}-?\d{4}/;

/**
 * The vendor's request id, only in the form such ids have (a UUID or a hex id of 8 to 64 characters), or
 * undefined. Anything else, and an id that holds the shape of a personal number, is dropped: the value comes from
 * the vendor and is kept only when it cannot be text.
 */
export function vendorRequestId(value: string | null | undefined): string | undefined {
  if (typeof value !== 'string') return undefined;
  const id = value.trim();
  return id.length >= 8 && id.length <= 64 && REQUEST_ID_FORM.test(id) && !PERSONAL_NUMBER_SHAPE.test(id) ? id : undefined;
}

/** The vendor's request id from the first of REQUEST_ID_HEADERS a response has in the right form, or undefined. */
export function requestIdFrom(headers: Headers, names: readonly string[] = REQUEST_ID_HEADERS): string | undefined {
  for (const name of names) {
    const id = vendorRequestId(headers.get(name));
    if (id !== undefined) return id;
  }
  return undefined;
}

/**
 * Metadata about a failed call, for a host that counts failures: the HTTP status e-conomic answered with and its
 * request id. Never the response body (not its logId either), the vendor's error code or message, or the input.
 */
export interface FailureMetadata {
  /** The HTTP status of e-conomic's answer (100-599). */
  httpStatus: number;
  /** The vendor's own id for the request, as a UUID or hex id only. */
  requestId?: string;
}

/**
 * The failure metadata of an error: an HTTP error from e-conomic (a refused redirect included) gives its status and
 * request id; so does an error of ours that has one as its cause.
 */
export function failureMetadata(error: unknown): FailureMetadata | undefined {
  let current = error;
  for (let depth = 0; depth < 4 && current instanceof Error && !(current instanceof EconomicHttpError); depth += 1) {
    current = current.cause;
  }
  if (!(current instanceof EconomicHttpError)) return undefined;
  const status = current.status;
  if (!Number.isInteger(status) || status < 100 || status > 599) return undefined;
  const requestId = vendorRequestId(current.requestId);
  return requestId === undefined ? { httpStatus: status } : { httpStatus: status, requestId };
}

export function formatUnknownError(error: unknown, redactor?: SecretRedactor): string {
  if (error instanceof Error) {
    return clampMessage(redactSecrets(error.message, redactor));
  }

  return clampMessage(redactSecrets(String(error), redactor));
}

/** Longest error message returned to a client; the full payload stays on EconomicHttpError.payload. */
export const MAX_ERROR_MESSAGE_LENGTH = 500;

/** Shortens a (redacted) message to MAX_ERROR_MESSAGE_LENGTH characters. Redact first, then clamp. */
export function clampMessage(message: string, max = MAX_ERROR_MESSAGE_LENGTH): string {
  return message.length <= max ? message : `${message.slice(0, max)}... [truncated]`;
}

const MIN_SECRET_LENGTH = 8;
export const MAX_REGISTERED_SECRETS = 100;

/**
 * Credential values to redact by value, plus the header/name patterns.
 *
 * The standalone server uses one process-wide redactor for the tokens it reads
 * from its environment. An embedding host gets a redactor per gateway instance
 * (and per call for a per-call token), so one tenant's token never lands in
 * shared process state. Bounded: the most recently added values are kept.
 */
export class SecretRedactor {
  private readonly values = new Set<string>();

  constructor(private readonly max = MAX_REGISTERED_SECRETS) {}

  /** Adds a credential value (and its URL-encoded form). Short values are ignored. */
  add(value: string | undefined): void {
    if (!value || value.length < MIN_SECRET_LENGTH) {
      return;
    }
    this.remember(value);
    const encoded = encodeURIComponent(value);
    if (encoded !== value) {
      this.remember(encoded);
    }
  }

  /** A new redactor holding the same values; adding to it does not change this one. */
  fork(): SecretRedactor {
    const copy = new SecretRedactor(this.max);
    for (const value of this.values) {
      copy.remember(value);
    }
    return copy;
  }

  get size(): number {
    return this.values.size;
  }

  /**
   * True when `value` holds a piece of a credential value (MIN_SECRET_LENGTH characters or more), or a credential
   * holds it whole: such a value is not passed on, even where redaction would leave it unchanged.
   */
  sharesPiece(value: string): boolean {
    for (const secret of this.values) {
      if (secret.includes(value) || value.includes(secret)) return true;
      for (let start = 0; start + MIN_SECRET_LENGTH <= value.length; start += 1) {
        if (secret.includes(value.slice(start, start + MIN_SECRET_LENGTH))) return true;
      }
    }
    return false;
  }

  redact(value: string): string {
    let result = value;
    for (const secret of this.values) {
      result = result.split(secret).join('[REDACTED]');
    }
    return SECRET_PATTERNS.reduce((current, pattern) => current.replace(pattern, match => {
      const separator = match.includes(':') ? ':' : '=';
      const key = match.split(separator)[0]?.trim() ?? 'secret';
      return `${key}${separator} [REDACTED]`;
    }), result);
  }

  private remember(value: string): void {
    // Re-insert to mark as most recent; evict the oldest beyond the bound.
    this.values.delete(value);
    this.values.add(value);
    while (this.values.size > this.max) {
      const oldest = this.values.values().next().value;
      if (oldest === undefined) {
        break;
      }
      this.values.delete(oldest);
    }
  }
}

/**
 * Process-wide redactor of the standalone server (tokens from its environment).
 * The embedded gateway never adds to it.
 */
const processRedactor = new SecretRedactor();

/** Registers a credential value with the process-wide redactor (standalone server only). */
export function registerSecret(value: string | undefined): void {
  processRedactor.add(value);
}

/** Number of values held by the process-wide redactor (for tests). */
export function registeredSecretCount(): number {
  return processRedactor.size;
}

/** The process-wide redactor, used when no instance redactor is given. */
export function defaultRedactor(): SecretRedactor {
  return processRedactor;
}

export function redactSecrets(value: string, redactor: SecretRedactor = processRedactor): string {
  return redactor.redact(value);
}

function formatEconomicHttpError(input: {
  status: number;
  method: string;
  url: string;
  payload?: EconomicErrorPayload | unknown;
  retryAfter?: string;
  fallbackMessage?: string;
  redactor?: SecretRedactor;
}): string {
  const payload = isEconomicErrorPayload(input.payload) ? input.payload : undefined;
  const payloadErrors = Array.isArray(payload?.errors) ? JSON.stringify(payload.errors) : undefined;
  const parts = [
    `e-conomic API request failed with HTTP ${input.status}`,
    `${input.method.toUpperCase()} ${redactSecrets(input.url, input.redactor)}`,
    payload?.message,
    payload?.error,
    payloadErrors,
    payload?.logId ? `logId=${payload.logId}` : undefined,
    input.retryAfter ? `retry-after=${input.retryAfter}` : undefined,
    input.fallbackMessage,
  ].filter(Boolean);

  return clampMessage(redactSecrets(parts.join(' | '), input.redactor));
}

function isEconomicErrorPayload(value: unknown): value is EconomicErrorPayload {
  return typeof value === 'object' && value !== null;
}
