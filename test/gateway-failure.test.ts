// Failure metadata on gateway error results: e-conomic's HTTP status and its request id (a UUID or hex id only), for
// a host that counts failures without reading their text. Never the body, the vendor's code, message or logId.
import { describe, expect, it } from 'vitest';
import { EconomicHttpError, failureMetadata, REQUEST_ID_HEADERS, requestIdFrom, SecretRedactor, vendorRequestId } from '../src/errors.js';
import { createEconomicGateway } from '../src/gateway.js';

const APP_SECRET = 'app-secret-for-tests';
const GRANT = 'grant-token-for-tests';
const UUID = '3f2b8c1e-9a4d-4e6f-8b7a-1c2d3e4f5a6b';
const LOG_ID = 'abcdef0123456789abcdef0123456789';
const URL_SELF = 'https://restapi.e-conomic.com/self';

function gatewayWith(fetchImpl: typeof fetch, grant = GRANT, extra: Record<string, unknown> = {}) {
  return createEconomicGateway({ appSecretToken: APP_SECRET, agreementGrantToken: grant, fetchImpl, ...extra });
}

function answering(status: number, headers: Record<string, string>, body: unknown = { message: 'Customer Jane Doe not found', errorCode: 'E_NOPE', logId: LOG_ID }) {
  return (async () =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } })) as typeof fetch;
}

describe('vendorRequestId', () => {
  it('keeps a UUID and a hex id', () => {
    expect(vendorRequestId(UUID)).toBe(UUID);
    expect(vendorRequestId(` ${UUID} `)).toBe(UUID);
    expect(vendorRequestId('a1b2c3d4e5f60718')).toBe('a1b2c3d4e5f60718');
    expect(vendorRequestId('ABCDEF12-3456')).toBe('ABCDEF12-3456');
    expect(vendorRequestId('f'.repeat(64))).toBe('f'.repeat(64));
  });

  it('drops anything that could be text, and the shape of a personal number', () => {
    for (const value of [
      undefined,
      null,
      '',
      'abc123',
      'Jane Doe',
      'jane@example.com',
      'req_8f3a9c2d1e',
      'deadbeef deadbeef',
      '0101901234',
      'ab-010190-1234-cd',
      'f'.repeat(65),
      '-abcdef12',
      'abcdef12-',
      'a-------',
      'abc--def',
      'abcd--ef12',
      'abcdef12-ab',
      'abcdef1',
      'abcdef12-'.repeat(8),
    ]) {
      expect(vendorRequestId(value)).toBeUndefined();
    }
  });

  it('reads the first header that has an id in the right form', () => {
    expect(requestIdFrom(new Headers({ 'x-request-id': 'not an id', 'request-id': UUID }))).toBe(UUID);
    expect(requestIdFrom(new Headers({ 'x-correlation-id': 'deadbeefcafe' }))).toBe('deadbeefcafe');
    expect(requestIdFrom(new Headers({ 'x-vendor-id': UUID }))).toBeUndefined();
    expect(requestIdFrom(new Headers({ 'x-vendor-id': UUID }), ['x-vendor-id'])).toBe(UUID);
    expect(requestIdFrom(new Headers({ [REQUEST_ID_HEADERS[0]!]: UUID }))).toBe(UUID);
  });

  it('gives metadata for an HTTP error only, also as the cause of one of ours', () => {
    expect(failureMetadata(new EconomicHttpError({ status: 404, method: 'GET', url: URL_SELF, requestId: UUID }))).toEqual({
      httpStatus: 404,
      requestId: UUID,
    });
    expect(failureMetadata(new EconomicHttpError({ status: 500, method: 'GET', url: URL_SELF, requestId: 'Jane Doe' }))).toEqual({
      httpStatus: 500,
    });
    const cause = new EconomicHttpError({ status: 403, method: 'GET', url: URL_SELF, requestId: UUID });
    expect(failureMetadata(new Error('Booking blocked.', { cause }))).toEqual({ httpStatus: 403, requestId: UUID });
    expect(failureMetadata(new Error('boom', { cause: new TypeError('fetch failed') }))).toBeUndefined();
    expect(failureMetadata(new Error('boom'))).toBeUndefined();
    expect(failureMetadata('boom')).toBeUndefined();
  });

  it('knows a value that holds a piece of a credential', () => {
    const redactor = new SecretRedactor();
    redactor.add('deadbeef00112233-key-0');
    expect(redactor.sharesPiece('deadbeef00112233')).toBe(true);
    expect(redactor.sharesPiece('0011223344556677')).toBe(true);
    expect(redactor.sharesPiece(UUID)).toBe(false);
  });
});

describe('gateway error results', () => {
  it('carry the HTTP status and the request id, never the body or its logId', async () => {
    const result = await gatewayWith(answering(404, { [REQUEST_ID_HEADERS[0]!]: UUID })).callTool('check_connection', {});
    expect(result.isError).toBe(true);
    expect(result.failure).toEqual({ httpStatus: 404, requestId: UUID });
    expect(JSON.stringify(result.failure)).not.toContain(LOG_ID);
  });

  it('carry the status and request id of a refused redirect, never its Location', async () => {
    const result = await gatewayWith(
      answering(302, { 'x-request-id': UUID, location: 'https://elsewhere.example/Jane-Doe' }),
    ).callTool('check_connection', {});
    expect(result.isError).toBe(true);
    expect(result.failure).toEqual({ httpStatus: 302, requestId: UUID });
    expect(JSON.stringify(result)).not.toContain('Jane-Doe');
  });

  it('carry them when a missing record is answered in our own words', async () => {
    const result = await gatewayWith(answering(404, { 'x-request-id': UUID }), GRANT, { enableWrites: true }).callTool(
      'update_draft_invoice',
      { draftInvoiceNumber: 5, reference: 'R1' },
    );
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain('Draft invoice 5 does not exist');
    expect(result.failure).toEqual({ httpStatus: 404, requestId: UUID });
  });

  it('carry the 404 when upsert_product finds no product and the create is refused', async () => {
    const gw = gatewayWith(answering(404, { 'x-request-id': UUID }), GRANT, { enableWrites: true });
    const product = await gw.callTool('upsert_product', { productNumber: 'P1', salesPrice: 10 });
    expect(product.isError).toBe(true);
    expect(product.content[0]!.text).toContain('Creating a product requires');
    expect(product.failure).toEqual({ httpStatus: 404, requestId: UUID });
  });

  it('carry them when a delete tool finds no record to delete', async () => {
    const result = await gatewayWith(answering(404, { 'x-request-id': UUID }), GRANT, { enableWrites: true }).callTool(
      'delete_time_entry',
      { timeEntryNumber: 5 },
    );
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain('Time entry 5 does not exist');
    expect(result.failure).toEqual({ httpStatus: 404, requestId: UUID });
  });

  it('carry them when the module is not enabled', async () => {
    const fetchImpl = (async (input: string | URL | Request) =>
      new URL(String(input)).pathname === '/self'
        ? Response.json({ application: { requiredRoles: [{ roleNumber: 2, name: 'SuperUser' }] }, modules: [] })
        : new Response('{}', { status: 403, headers: { 'x-request-id': UUID } })) as typeof fetch;
    const result = await gatewayWith(fetchImpl, GRANT, { enableWrites: true }).callTool('add_subscriber', {
      subscriptionNumber: 1,
      customerNumber: 2,
      startDate: '2026-01-01',
      endDate: '2026-01-31',
    });
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain('module is not enabled');
    expect(result.failure).toEqual({ httpStatus: 403, requestId: UUID });
  });

  it('keep the status and request id when reading the error body fails', async () => {
    const fetchImpl = (async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          pull(controller) {
            controller.error(new TypeError('terminated', { cause: Object.assign(new Error('other side closed'), { code: 'ECONNRESET' }) }));
          },
        }),
        { status: 503, headers: { 'content-type': 'application/json', 'x-request-id': UUID } },
      )) as typeof fetch;
    const result = await gatewayWith(fetchImpl).callTool('check_connection', {});
    expect(result.isError).toBe(true);
    expect(result.failure).toEqual({ httpStatus: 503, requestId: UUID });
  });

  it('carry the status alone when the request id is not in the form of one', async () => {
    const result = await gatewayWith(answering(422, { 'x-request-id': 'Jane Doe <jane@example.com>' })).callTool('check_connection', {});
    expect(result.failure).toEqual({ httpStatus: 422 });
    expect(JSON.stringify(result.failure)).not.toContain('jane@example.com');
  });

  it('drop a request id that holds a piece of a credential', async () => {
    const fetchImpl = (async () =>
      new Response('{}', { status: 500, headers: { 'x-request-id': 'deadbeef00112233' } })) as typeof fetch;
    const result = await gatewayWith(fetchImpl, 'deadbeef00112233-key-0').callTool('check_connection', {});
    expect(result.isError).toBe(true);
    expect(result.failure).toEqual({ httpStatus: 500 });
    expect(JSON.stringify(result)).not.toContain('deadbeef0011');
  });

  it('have no metadata when the cause is not e-conomic', async () => {
    const gw = gatewayWith(answering(200, {}, { collection: [] }));
    expect((await gw.callTool('no_such_tool', {})).failure).toBeUndefined();
    const offline = gatewayWith((async () => {
      throw new TypeError('fetch failed');
    }) as typeof fetch);
    const result = await offline.callTool('check_connection', {});
    expect(result.isError).toBe(true);
    expect(result.failure).toBeUndefined();
  });

  it('are absent on a successful result', async () => {
    const result = await gatewayWith(answering(200, { 'x-request-id': UUID }, { agreementNumber: 1 })).callTool('check_connection', {});
    expect(result.isError).toBeUndefined();
    expect(result.failure).toBeUndefined();
  });
});
