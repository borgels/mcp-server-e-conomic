import { readEnvInteger, type Env } from '../config-env.js';
import { EconomicHttpError, SecretRedactor, defaultRedactor, requestIdFrom } from '../errors.js';
import { EconomicFenceError, fenceRule } from './fence.js';
import { normalizeJsonBody } from './json.js';

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
export type QueryValue = string | number | boolean | null | undefined;
export type RawBody = Uint8Array | ArrayBuffer | string;

export interface EconomicClientOptions {
  appSecretToken?: string;
  agreementGrantToken?: string;
  restBaseUrl?: string;
  openApiBaseUrl?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  /**
   * Where omitted options (credentials, base URLs, timeout) are read from.
   * Defaults to `process.env` for the standalone server. The embedded gateway
   * passes `{}`, so an instance only ever uses what it was given.
   */
  credentialEnv?: Env;
  /**
   * Redactor for this client's tokens. Defaults to the process-wide redactor
   * (standalone server); the embedded gateway passes its own instance.
   */
  redactor?: SecretRedactor;
  /**
   * Refuse the requests in GATEWAY_FENCE before they are sent. The embedded
   * gateway sets it; the standalone server does not.
   */
  fence?: boolean;
}

/** Headers a caller can never set: the credentials are the client's own. */
const RESERVED_HEADERS = new Set(['x-appsecrettoken', 'x-agreementgranttoken']);

export interface EconomicRequestOptions {
  method?: HttpMethod;
  url?: string;
  path?: string;
  query?: Record<string, QueryValue>;
  body?: unknown;
  rawBody?: RawBody;
  rawContentType?: string;
  headers?: Record<string, string>;
  idempotencyKey?: string;
  /**
   * Read a successful answer as bytes (a PDF) instead of JSON, refusing one
   * larger than `maxBytes`. The result is an EconomicBinaryBody.
   */
  binary?: { maxBytes: number };
}

/** A successful binary answer (`binary` option). */
export interface EconomicBinaryBody {
  readonly contentType: string;
  readonly bytes: Uint8Array;
}

export interface EconomicRawBodyOptions {
  method?: HttpMethod;
  query?: Record<string, QueryValue>;
  body: RawBody;
  contentType: string;
  headers?: Record<string, string>;
  idempotencyKey?: string;
}

/** A request e-conomic refused with HTTP 403: its method, the API it was sent to and its path there. */
export interface EconomicRefusedRequest {
  readonly method: string;
  /** Classic REST or the OpenAPI services; undefined when the URL is on neither base URL. */
  readonly surface: 'rest' | 'openapi' | undefined;
  /** The path relative to the base URL, without the query: "/projectsapi/v1.1.1/Projects/paged", "/departments/3". */
  readonly path: string;
}

export class EconomicClient {
  private readonly appSecretToken?: string;
  private readonly agreementGrantToken?: string;
  private readonly restBaseUrl: string;
  private readonly openApiBaseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly redactor: SecretRedactor;
  private readonly fence: boolean;
  private readonly refusedRequests: EconomicRefusedRequest[] = [];

  /**
   * The requests of this client that e-conomic refused with HTTP 403, in the order they were answered: what was
   * asked for, so a caller can tell which resource a refusal was about. Paths only, never a query or an answer.
   */
  get refused(): readonly EconomicRefusedRequest[] {
    return [...this.refusedRequests];
  }

  constructor(options: EconomicClientOptions = {}) {
    const env = options.credentialEnv ?? process.env;
    this.appSecretToken = options.appSecretToken ?? env.ECONOMIC_APP_SECRET_TOKEN;
    this.agreementGrantToken =
      options.agreementGrantToken ?? env.ECONOMIC_AGREEMENT_GRANT_TOKEN;
    this.restBaseUrl = trimTrailingSlash(
      options.restBaseUrl ?? env.ECONOMIC_BASE_URL_REST ?? 'https://restapi.e-conomic.com',
    );
    this.openApiBaseUrl = trimTrailingSlash(
      options.openApiBaseUrl ??
        env.ECONOMIC_BASE_URL_OPENAPI ??
        'https://apis.e-conomic.com',
    );
    assertSafeBaseUrl(this.restBaseUrl, 'ECONOMIC_BASE_URL_REST');
    assertSafeBaseUrl(this.openApiBaseUrl, 'ECONOMIC_BASE_URL_OPENAPI');
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs =
      options.timeoutMs ?? readEnvInteger('ECONOMIC_TIMEOUT_MS', 30_000, { min: 1, max: 600_000 }, env);
    this.redactor = options.redactor ?? defaultRedactor();
    this.fence = options.fence === true;
    this.redactor.add(this.appSecretToken);
    this.redactor.add(this.agreementGrantToken);
  }

  async rest<T>(path: string, options: Omit<EconomicRequestOptions, 'path' | 'url'> = {}): Promise<T> {
    return this.request<T>({ ...options, path });
  }

  async restRawBody<T>(path: string, options: EconomicRawBodyOptions): Promise<T> {
    return this.request<T>({
      path,
      method: options.method ?? 'PUT',
      query: options.query,
      rawBody: options.body,
      rawContentType: options.contentType,
      headers: options.headers,
      idempotencyKey: options.idempotencyKey,
    });
  }

  async openApi<T>(
    servicePath: string,
    apiPath: string,
    options: Omit<EconomicRequestOptions, 'path' | 'url'> = {},
  ): Promise<T> {
    const service = servicePath.replace(/^\/+|\/+$/g, '');
    const path = apiPath.startsWith('/') ? apiPath : `/${apiPath}`;
    return this.request<T>({
      ...options,
      url: `${this.openApiBaseUrl}/${service}${path}`,
    });
  }

  async request<T>(options: EconomicRequestOptions): Promise<T> {
    this.assertConfigured();

    if (options.body !== undefined && options.rawBody !== undefined) {
      throw new Error('EconomicClient.request: pass either body (JSON) or rawBody, not both.');
    }

    const method = options.method ?? 'GET';
    const url = options.url ?? this.buildRestUrl(options.path ?? '/', options.query);
    const resolvedUrl = options.url ? appendQuery(url, options.query) : url;
    if (this.fence) {
      const path = this.relativePath(resolvedUrl);
      const rule = fenceRule(method, path);
      if (rule) {
        throw new EconomicFenceError(method, path, rule);
      }
    }
    for (const name of Object.keys(options.headers ?? {})) {
      if (RESERVED_HEADERS.has(name.toLowerCase())) {
        throw new Error(`EconomicClient.request: the ${name} header is set by the client and cannot be given.`);
      }
    }
    // The credential headers come last, so nothing given with a call replaces them.
    const headers: Record<string, string> = {
      Accept: 'application/json',
      ...options.headers,
      'X-AppSecretToken': this.appSecretToken ?? '',
      'X-AgreementGrantToken': this.agreementGrantToken ?? '',
    };

    if (options.body !== undefined) {
      headers['Content-Type'] = 'application/json';
    } else if (options.rawBody !== undefined) {
      headers['Content-Type'] = options.rawContentType ?? 'application/octet-stream';
    }

    if (options.idempotencyKey) {
      headers['Idempotency-Key'] = options.idempotencyKey;
    }

    const fetchBody =
      options.rawBody !== undefined
        ? options.rawBody
        : options.body === undefined
          ? undefined
          : JSON.stringify(normalizeJsonBody(options.body));

    const response = await this.fetchImpl(resolvedUrl, {
      method,
      headers,
      body: fetchBody,
      // Never follow a redirect: the token headers would be resent to the target.
      redirect: 'manual',
      signal: AbortSignal.timeout(this.timeoutMs),
    });

    if (response.status >= 300 && response.status < 400) {
      void response.body?.cancel().catch(() => undefined);
      throw new EconomicHttpError({
        status: response.status,
        method,
        url: resolvedUrl,
        fallbackMessage: 'redirect not followed (check ECONOMIC_BASE_URL_REST / ECONOMIC_BASE_URL_OPENAPI)',
        redactor: this.redactor,
        requestId: requestIdFrom(response.headers),
      });
    }

    if (response.ok && options.binary) {
      return (await readBinaryBody(response, options.binary.maxBytes)) as T;
    }

    if (!response.ok) {
      // e-conomic has answered with its status: a body that cannot be read (a timeout or a dropped connection) is
      // left out, so the error is the status alone and keeps its status and request id.
      const body = await readResponseBody(response).catch(() => undefined);
      if (response.status === 403) {
        this.refusedRequests.push({
          method,
          surface: this.surfaceOf(resolvedUrl),
          path: this.relativePath(resolvedUrl),
        });
      }
      throw new EconomicHttpError({
        status: response.status,
        method,
        url: resolvedUrl,
        payload: body,
        retryAfter: response.headers.get('retry-after') ?? undefined,
        fallbackMessage: typeof body === 'string' ? body : undefined,
        redactor: this.redactor,
        requestId: requestIdFrom(response.headers),
      });
    }

    const body = await readResponseBody(response);

    return body as T;
  }

  /** Which of the two base URLs a request was built on; undefined for a URL on neither. */
  private surfaceOf(resolvedUrl: string): 'rest' | 'openapi' | undefined {
    const on = (base: string) => resolvedUrl === base || resolvedUrl.startsWith(`${trimTrailingSlash(base)}/`);
    const openApi = on(this.openApiBaseUrl);
    const rest = on(this.restBaseUrl);
    // Both on the same base (a proxy in front of e-conomic): the surface cannot be told from the URL.
    if (openApi === rest) return undefined;
    return openApi ? 'openapi' : 'rest';
  }

  buildRestUrl(path: string, query?: Record<string, QueryValue>): string {
    const normalizedPath = path.startsWith('/') ? path : `/${path}`;
    return appendQuery(`${this.restBaseUrl}${normalizedPath}`, query);
  }

  /** The request path relative to the base URL it was built on (REST or OpenAPI). */
  private relativePath(resolvedUrl: string): string {
    const { pathname } = new URL(resolvedUrl);
    for (const base of [this.openApiBaseUrl, this.restBaseUrl]) {
      const basePath = trimTrailingSlash(new URL(base).pathname);
      if (resolvedUrl.startsWith(base) && basePath && pathname.startsWith(basePath)) {
        return pathname.slice(basePath.length) || '/';
      }
    }
    return pathname;
  }

  private assertConfigured(): void {
    if (!this.appSecretToken || !this.agreementGrantToken) {
      throw new Error(
        'Missing e-conomic credentials. Set ECONOMIC_APP_SECRET_TOKEN and ECONOMIC_AGREEMENT_GRANT_TOKEN in the MCP server environment.',
      );
    }
  }
}

/** Error bodies are read up to this many bytes; the rest is discarded. */
const MAX_ERROR_BODY_BYTES = 64 * 1024;

async function readResponseBody(response: Response): Promise<unknown> {
  if (response.status === 204) {
    return null;
  }

  const { text, truncated } = response.ok
    ? { text: await response.text(), truncated: false }
    : await readTextUpTo(response, MAX_ERROR_BODY_BYTES);

  if (!text) {
    return null;
  }

  if (truncated) {
    return `${text}... [truncated]`;
  }

  const contentType = response.headers.get('content-type') ?? '';
  if (!contentType.includes('application/json')) {
    return text;
  }

  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

/** Reads a binary body, refusing one larger than `maxBytes` (the rest is not read). */
async function readBinaryBody(response: Response, maxBytes: number): Promise<EconomicBinaryBody> {
  const contentType = (response.headers.get('content-type') ?? 'application/octet-stream').split(';')[0]!.trim();
  const declared = Number(response.headers.get('content-length') ?? NaN);
  if (Number.isFinite(declared) && declared > maxBytes) {
    void response.body?.cancel().catch(() => undefined);
    throw new Error(`The file is larger than ${Math.floor(maxBytes / (1024 * 1024))} MB; open it in e-conomic.`);
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  if (response.body) {
    const reader = response.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new Error(`The file is larger than ${Math.floor(maxBytes / (1024 * 1024))} MB; open it in e-conomic.`);
      }
      chunks.push(value);
    }
  }
  return { contentType, bytes: new Uint8Array(Buffer.concat(chunks)) };
}

/** Reads at most `limit` bytes of the body as text and cancels the rest. */
async function readTextUpTo(response: Response, limit: number): Promise<{ text: string; truncated: boolean }> {
  if (!response.body) {
    return { text: '', truncated: false };
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    if (total + value.byteLength > limit) {
      chunks.push(value.subarray(0, limit - total));
      truncated = true;
      await reader.cancel().catch(() => undefined);
      break;
    }
    chunks.push(value);
    total += value.byteLength;
  }
  return { text: Buffer.concat(chunks).toString('utf8'), truncated };
}

function appendQuery(urlValue: string, query?: Record<string, QueryValue>): string {
  const url = new URL(urlValue);

  for (const [key, value] of Object.entries(query ?? {})) {
    if (value === undefined || value === null || value === '') {
      continue;
    }

    url.searchParams.set(key, String(value));
  }

  return url.toString();
}

function trimTrailingSlash(value: string): string {
  // Linear scan instead of /\/+$/ (which backtracks polynomially on long
  // runs of slashes not at the end of the string).
  let end = value.length;
  while (end > 0 && value.charCodeAt(end - 1) === 0x2f) {
    end -= 1;
  }
  return value.slice(0, end);
}

function assertSafeBaseUrl(baseUrl: string, envName: string): void {
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new Error(`${envName} is not a valid URL: ${baseUrl}`);
  }

  if (parsed.protocol === 'https:') {
    return;
  }

  if (parsed.protocol === 'http:' && isLocalHost(parsed.hostname)) {
    return;
  }

  throw new Error(
    `Refusing to send e-conomic credentials over ${parsed.protocol}//. Use https:// (loopback http:// is allowed for local mocks).`,
  );
}

function isLocalHost(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
}
