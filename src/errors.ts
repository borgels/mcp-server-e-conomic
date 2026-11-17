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

  constructor(input: {
    status: number;
    method: string;
    url: string;
    payload?: EconomicErrorPayload | unknown;
    retryAfter?: string;
    fallbackMessage?: string;
    redactor?: SecretRedactor;
  }) {
    super(formatEconomicHttpError(input));
    this.name = 'EconomicHttpError';
    this.status = input.status;
    this.method = input.method;
    this.url = redactSecrets(input.url, input.redactor);
    this.payload = input.payload;
    this.retryAfter = input.retryAfter;
    this.logId = isEconomicErrorPayload(input.payload) ? input.payload.logId : undefined;
  }
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
