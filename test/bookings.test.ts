import { afterEach, describe, expect, it, vi } from 'vitest';
import { EconomicClient } from '../src/economic/client.js';
import { prepareBooking, prepareOpenItemMatch } from '../src/economic/bookings.js';
import { checkPolicy } from '../src/economic/policy.js';

const originalEnv = { ...process.env };

afterEach(() => {
  process.env = { ...originalEnv };
});

function makeClient(handler: (url: string) => unknown): EconomicClient {
  const fetchImpl = vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    const payload = handler(url);
    if (payload instanceof Response) {
      return payload;
    }
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  });

  return new EconomicClient({
    appSecretToken: 'app',
    agreementGrantToken: 'grant',
    fetchImpl: fetchImpl as unknown as typeof fetch,
  });
}

const drafts = {
  cursor: null,
  items: [
    { entryNumber: 11, journalNumber: 3, voucherNumber: 901, amount: 1200.5, text: 'Betaling A' },
    { entryNumber: 12, journalNumber: 3, voucherNumber: 901, amount: -1200.5, text: 'Modkonto' },
    { entryNumber: 20, journalNumber: 7, voucherNumber: 950, amount: 99, text: 'Andet journal' },
    { entryNumber: 30, journalNumber: 3, amount: 50, text: 'Uden bilag' },
  ],
};

function draftAndDocsHandler(url: string): unknown {
  if (url.includes('/draft-entries')) {
    return drafts;
  }
  if (url.includes('/AttachedDocuments/901')) {
    return { voucherNumber: 901, attachments: 1 };
  }
  return new Response('not found', { status: 404 });
}

describe('prepareBooking', () => {
  it('validates entries, checks vouchers, and prepares the bookdraftentries operation', async () => {
    process.env.ECONOMIC_ENABLE_WRITES = 'true';
    process.env.ECONOMIC_ENABLE_BOOKING = 'true';
    const client = makeClient(draftAndDocsHandler);

    const prepared = await prepareBooking(client, {
      journalNumber: 3,
      entryNumbers: [11, 12],
      reason: 'matcher banktransaktion 2026-07-14',
    });

    expect(prepared.operation.pathTemplate).toBe('/journals/{journalNumber}/bookdraftentries');
    expect(prepared.operation.body).toEqual({ entryNumbers: [11, 12] });
    expect(prepared.operation.policyDecision.allowed).toBe(true);
    expect(prepared.validation.totalAbsoluteAmount).toBe(2401);
    expect(prepared.validation.vouchersChecked).toEqual([901]);
    expect(prepared.note).toContain('IRREVERSIBLE');
  });

  it('rejects entries from another journal, missing entries, and missing vouchers', async () => {
    process.env.ECONOMIC_ENABLE_WRITES = 'true';
    process.env.ECONOMIC_ENABLE_BOOKING = 'true';
    const client = makeClient(draftAndDocsHandler);

    await expect(
      prepareBooking(client, { journalNumber: 3, entryNumbers: [20], reason: 'forkert journal her' }),
    ).rejects.toThrow('journal 7');

    await expect(
      prepareBooking(client, { journalNumber: 3, entryNumbers: [999], reason: 'findes ikke mere' }),
    ).rejects.toThrow('not found');

    await expect(
      prepareBooking(client, { journalNumber: 3, entryNumbers: [30], reason: 'mangler bilagsnummer' }),
    ).rejects.toThrow('no voucher numbers');
  });

  it('blocks amounts above policy maxAmount', async () => {
    process.env.ECONOMIC_ENABLE_WRITES = 'true';
    process.env.ECONOMIC_ENABLE_BOOKING = 'true';
    process.env.ECONOMIC_POLICY_PATH = '';
    const client = makeClient(draftAndDocsHandler);

    // maxAmount comes from a policy file; emulate via ECONOMIC_POLICY_PATH
    const { writeFileSync, mkdtempSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = mkdtempSync(join(tmpdir(), 'policy-'));
    const policyPath = join(dir, 'policy.json');
    writeFileSync(policyPath, JSON.stringify({ maxAmount: 1000 }));
    process.env.ECONOMIC_POLICY_PATH = policyPath;

    await expect(
      prepareBooking(client, { journalNumber: 3, entryNumbers: [11, 12], reason: 'over beløbsgrænsen' }),
    ).rejects.toThrow('maxAmount 1000');
  });
});

describe('booking policy', () => {
  it('denies booking capabilities unless ECONOMIC_ENABLE_BOOKING is set', () => {
    process.env.ECONOMIC_ENABLE_WRITES = 'true';
    delete process.env.ECONOMIC_ENABLE_BOOKING;

    expect(
      checkPolicy({
        capability: 'economic_prepare_booking',
        serviceId: 'journals',
        method: 'POST',
        path: '/journals/3/bookdraftentries',
      }),
    ).toMatchObject({ allowed: false, reason: expect.stringContaining('booking disabled') });

    process.env.ECONOMIC_ENABLE_BOOKING = 'true';
    expect(
      checkPolicy({
        capability: 'economic_prepare_booking',
        serviceId: 'journals',
        method: 'POST',
        path: '/journals/{journalNumber}/bookdraftentries',
      }),
    ).toMatchObject({ allowed: true });
  });

  it('keeps booking paths denied for every other capability and confines booking capabilities to their endpoint', () => {
    process.env.ECONOMIC_ENABLE_WRITES = 'true';
    process.env.ECONOMIC_ENABLE_BOOKING = 'true';

    expect(
      checkPolicy({
        capability: 'economic_call_endpoint',
        serviceId: 'journals',
        method: 'POST',
        path: '/journals/3/bookdraftentries',
      }),
    ).toMatchObject({ allowed: false });

    expect(
      checkPolicy({
        capability: 'economic_prepare_booking',
        serviceId: 'rest',
        method: 'POST',
        path: '/invoices/booked',
      }),
    ).toMatchObject({ allowed: false, reason: expect.stringContaining('outside its endpoint') });
  });
});

describe('prepareOpenItemMatch', () => {
  it('prepares the match operation and requires at least two entries', () => {
    process.env.ECONOMIC_ENABLE_WRITES = 'true';
    process.env.ECONOMIC_ENABLE_BOOKING = 'true';

    const operation = prepareOpenItemMatch({ entryIds: [100, 200], reason: 'betaling mod faktura' });
    expect(operation.pathTemplate).toBe('/booked-entries/match');
    expect(operation.body).toEqual({ entryIds: [100, 200] });
    expect(operation.policyDecision.allowed).toBe(true);

    expect(() => prepareOpenItemMatch({ entryIds: [100], reason: 'for få poster her' })).toThrow('2-100');
  });
});
