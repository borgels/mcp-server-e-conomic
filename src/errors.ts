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
  }) {
    super(formatEconomicHttpError(input));
    this.name = 'EconomicHttpError';
    this.status = input.status;
    this.method = input.method;
    this.url = redactSecrets(input.url);
    this.payload = input.payload;
    this.retryAfter = input.retryAfter;
    this.logId = isEconomicErrorPayload(input.payload) ? input.payload.logId : undefined;
  }
}

export function formatUnknownError(error: unknown): string {
  if (error instanceof Error) {
    return clampMessage(redactSecrets(error.message));
  }

  return clampMessage(redactSecrets(String(error)));
}

/** Longest error message returned to a client; the full payload stays on EconomicHttpError.payload. */
export const MAX_ERROR_MESSAGE_LENGTH = 500;

/** Shortens a (redacted) message to MAX_ERROR_MESSAGE_LENGTH characters. Redact first, then clamp. */
export function clampMessage(message: string, max = MAX_ERROR_MESSAGE_LENGTH): string {
  return message.length <= max ? message : `${message.slice(0, max)}... [truncated]`;
}

/**
 * Configured credential values, redacted wherever they appear. Bounded, so an
 * embedding host that creates a client per tenant does not grow it without
 * limit: the most recently registered values are kept.
 */
const registeredSecrets = new Set<string>();
const MIN_SECRET_LENGTH = 8;
export const MAX_REGISTERED_SECRETS = 100;

/** Registers a credential value so redactSecrets removes it by value. */
export function registerSecret(value: string | undefined): void {
  if (!value || value.length < MIN_SECRET_LENGTH) {
    return;
  }
  remember(value);
  const encoded = encodeURIComponent(value);
  if (encoded !== value) {
    remember(encoded);
  }
}

function remember(value: string): void {
  // Re-insert to mark as most recent; evict the oldest beyond the bound.
  registeredSecrets.delete(value);
  registeredSecrets.add(value);
  while (registeredSecrets.size > MAX_REGISTERED_SECRETS) {
    const oldest = registeredSecrets.values().next().value;
    if (oldest === undefined) {
      break;
    }
    registeredSecrets.delete(oldest);
  }
}

/** Number of registered secret values (for tests). */
export function registeredSecretCount(): number {
  return registeredSecrets.size;
}

export function redactSecrets(value: string): string {
  let result = value;
  for (const secret of registeredSecrets) {
    result = result.split(secret).join('[REDACTED]');
  }
  return SECRET_PATTERNS.reduce((current, pattern) => current.replace(pattern, match => {
    const separator = match.includes(':') ? ':' : '=';
    const key = match.split(separator)[0]?.trim() ?? 'secret';
    return `${key}${separator} [REDACTED]`;
  }), result);
}

function formatEconomicHttpError(input: {
  status: number;
  method: string;
  url: string;
  payload?: EconomicErrorPayload | unknown;
  retryAfter?: string;
  fallbackMessage?: string;
}): string {
  const payload = isEconomicErrorPayload(input.payload) ? input.payload : undefined;
  const payloadErrors = Array.isArray(payload?.errors) ? JSON.stringify(payload.errors) : undefined;
  const parts = [
    `e-conomic API request failed with HTTP ${input.status}`,
    `${input.method.toUpperCase()} ${redactSecrets(input.url)}`,
    payload?.message,
    payload?.error,
    payloadErrors,
    payload?.logId ? `logId=${payload.logId}` : undefined,
    input.retryAfter ? `retry-after=${input.retryAfter}` : undefined,
    input.fallbackMessage,
  ].filter(Boolean);

  return clampMessage(redactSecrets(parts.join(' | ')));
}

function isEconomicErrorPayload(value: unknown): value is EconomicErrorPayload {
  return typeof value === 'object' && value !== null;
}
