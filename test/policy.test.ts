import { afterEach, describe, expect, it } from 'vitest';
import { basePolicy, checkPolicy } from '../src/economic/policy.js';
import type { EconomicPolicy, PolicyCheckInput } from '../src/economic/policy.js';
import { prepareOperation, verifyPreparedOperation } from '../src/economic/operations.js';

const originalWrites = process.env.ECONOMIC_ENABLE_WRITES;

describe('write policy', () => {
  afterEach(() => {
    if (originalWrites === undefined) {
      delete process.env.ECONOMIC_ENABLE_WRITES;
    } else {
      process.env.ECONOMIC_ENABLE_WRITES = originalWrites;
    }
    delete process.env.ECONOMIC_POLICY_PATH;
  });

  it('allows reads by default', () => {
    expect(
      checkPolicy({
        capability: 'economic_call_endpoint',
        serviceId: 'customers',
        method: 'GET',
        path: '/Customers',
      }),
    ).toMatchObject({ allowed: true });
  });

  it('blocks writes by default', () => {
    delete process.env.ECONOMIC_ENABLE_WRITES;

    expect(
      checkPolicy({
        capability: 'economic_prepare_customer_change',
        serviceId: 'customers',
        method: 'POST',
        path: '/Customers',
        body: { name: 'Acme' },
      }),
    ).toMatchObject({ allowed: false, reason: 'writes disabled' });
  });

  it('never lets a raw call approve time entries, with or without booking; only the curated tool with booking', () => {
    const raw = { capability: 'economic_call_endpoint', serviceId: 'projects', method: 'POST' as const, path: '/TimeEntries/approve', body: { numbers: [5] } };
    for (const bookingEnabled of [false, true]) {
      const policy = { ...basePolicy(), writesEnabled: true, bookingEnabled };
      expect(checkPolicy(raw, policy), String(bookingEnabled)).toMatchObject({ allowed: false });
      expect(checkPolicy({ ...raw, path: '/timeentries/approve' }, policy), String(bookingEnabled)).toMatchObject({ allowed: false });
    }
    const curated = { ...raw, capability: 'approve_time_entries' };
    expect(checkPolicy(curated, { ...basePolicy(), writesEnabled: true, bookingEnabled: false })).toMatchObject({ allowed: false });
    expect(checkPolicy(curated, { ...basePolicy(), writesEnabled: true, bookingEnabled: true })).toMatchObject({ allowed: true });
  });

  it('prepares stable hashable dry-run operations', () => {
    const operation = prepareOperation({
      capability: 'economic_prepare_customer_change',
      serviceId: 'customers',
      method: 'POST',
      pathTemplate: '/Customers',
      body: { name: 'Acme' },
      reason: 'Create customer from CRM onboarding',
    });

    expect(operation.dryRun).toBe(true);
    expect(operation.operationHash).toHaveLength(64);
    expect(() => verifyPreparedOperation(operation)).not.toThrow();
  });

  it('detects tampered prepared operations', () => {
    const operation = prepareOperation({
      capability: 'economic_prepare_customer_change',
      serviceId: 'customers',
      method: 'POST',
      pathTemplate: '/Customers',
      body: { name: 'Acme' },
      reason: 'Create customer from CRM onboarding',
    });

    expect(() =>
      verifyPreparedOperation({
        ...operation,
        body: { name: 'Different' },
      }),
    ).toThrow('signature does not match');
  });

  describe('maxAmount', () => {
    const policy: EconomicPolicy = {
      writesEnabled: true,
      bookingEnabled: false,
      allowedCapabilities: [],
      allowedServices: [],
      allowedMethods: ['POST', 'PUT'],
      deniedPathPatterns: [],
      maxAmount: 50_000,
    };

    const input = (body: unknown): PolicyCheckInput => ({
      capability: 'economic_prepare_sales_document',
      serviceId: 'rest',
      method: 'POST',
      path: '/invoices/drafts',
      body,
    });

    it('does not treat a large identifier as an amount', () => {
      // customerNumber is an 8-digit id, not kroner. Before the fix this
      // blocked every write for any customer numbered above maxAmount.
      expect(
        checkPolicy(
          input({
            customer: { customerNumber: 12_345_678 },
            lines: [{ unitNetPrice: 39, quantity: 469 }],
          }),
          policy,
        ),
      ).toMatchObject({ allowed: true });
    });

    it('still blocks a monetary value above the limit', () => {
      expect(
        checkPolicy(
          input({
            customer: { customerNumber: 12_345_678 },
            lines: [{ totalNetAmount: 60_000 }],
          }),
          policy,
        ),
      ).toMatchObject({ allowed: false });
    });

    it('checks numbers in an array under a monetary key', () => {
      expect(checkPolicy(input({ totalAmounts: [10, 60_000] }), policy)).toMatchObject({
        allowed: false,
      });
    });

    it('ignores a non-monetary number nested under a monetary key', () => {
      expect(
        checkPolicy(input({ totals: { customerNumber: 12_345_678 } }), policy),
      ).toMatchObject({ allowed: true });
    });

    const blocked = (body: unknown) => checkPolicy(input(body), policy).allowed === false;

    it('catches the amount fields of draft invoices, quotes, orders and credit notes', () => {
      for (const path of ['/invoices/drafts', '/quotes/drafts', '/orders/drafts']) {
        const at = (body: unknown) => checkPolicy({ ...input(body), path }, policy).allowed;
        const ok = {
          customer: { customerNumber: 87_654_321 },
          paymentTerms: { paymentTermsNumber: 1 },
          layout: { layoutNumber: 21 },
          exchangeRate: 745.5,
          lines: [{ lineNumber: 1, product: { productNumber: '99887766' }, quantity: 600, unitNetPrice: 75, discountPercentage: 10 }],
        };
        expect(at(ok)).toBe(true);
        expect(at({ ...ok, lines: [{ quantity: 1, unitNetPrice: 60_000 }] })).toBe(false);
        expect(at({ ...ok, lines: [{ quantity: 1, unitNetPrice: 10, unitCostPrice: 60_000 }] })).toBe(false);
        for (const field of ['netAmount', 'grossAmount', 'vatAmount', 'roundingAmount', 'netAmountInBaseCurrency']) {
          expect(at({ ...ok, [field]: 60_000 })).toBe(false);
        }
      }
      // A credit note carries negative amounts: the absolute value counts.
      expect(blocked({ lines: [{ quantity: -1, unitNetPrice: -60_000 }] })).toBe(true);
      expect(blocked({ lines: [{ quantity: -1, unitNetPrice: -500 }] })).toBe(false);
    });

    it('catches journal voucher and payment amounts, not the account and invoice numbers', () => {
      const voucher = (amount: number) => ({
        accountingYear: { year: '2026' },
        journal: { journalNumber: 1 },
        voucherNumber: 12_345_678,
        entries: {
          financeVouchers: [{ date: '2026-11-20', amount, account: { accountNumber: 55_000 }, contraAccount: { accountNumber: 58_100 }, currency: { code: 'DKK' } }],
          customerPayments: [{ date: '2026-11-20', amount: 100, customer: { customerNumber: 87_654_321 }, customerInvoice: 87_654_321, contraAccount: { accountNumber: 58_100 } }],
          supplierInvoices: [{ date: '2026-11-20', amount: 100, amountDefaultCurrency: 100, supplier: { supplierNumber: 76_543_210 }, supplierInvoiceNumber: '76543210' }],
        },
      });
      expect(checkPolicy({ ...input(voucher(1_000)), path: '/journals/1/vouchers' }, policy)).toMatchObject({ allowed: true });
      expect(checkPolicy({ ...input(voucher(60_000)), path: '/journals/1/vouchers' }, policy)).toMatchObject({ allowed: false });
      expect(blocked({ entries: { supplierPayments: [{ amountDefaultCurrency: 60_000 }] } })).toBe(true);
    });

    it('catches product prices and a customer credit limit', () => {
      for (const field of ['salesPrice', 'costPrice', 'recommendedPrice']) {
        expect(blocked({ productNumber: '12345678', [field]: 60_000 })).toBe(true);
        expect(blocked({ productNumber: '12345678', [field]: 100 })).toBe(false);
      }
      expect(blocked({ customerNumber: 87_654_321, creditLimit: 60_000 })).toBe(true);
      expect(blocked({ customerNumber: 87_654_321, creditLimit: 10_000, balance: 0 })).toBe(false);
    });

    it('catches money nested under a monetary key, but not references there', () => {
      expect(blocked({ totals: { net: 60_000 } })).toBe(true);
      expect(blocked({ totals: { paid: 60_000 } })).toBe(true);
      expect(blocked({ amounts: [{ value: 60_000 }] })).toBe(true);
      expect(blocked({ totals: { accountNumber: 99_999_999, id: 99_999_999, customerId: 99_999_999, vatCode: 99_999_999 } })).toBe(false);
      expect(blocked({ totals: { customerNumber: 1, totalAmount: 60_000 } })).toBe(true);
    });

    it('compares a numeric string under a monetary key', () => {
      expect(blocked({ lines: [{ unitNetPrice: '60000' }] })).toBe(true);
      expect(blocked({ lines: [{ unitNetPrice: '60000,50' }] })).toBe(true);
      expect(blocked({ lines: [{ unitNetPrice: '499.95' }] })).toBe(false);
      expect(blocked({ customer: { customerNumber: '87654321' } })).toBe(false);
    });
  });

  it('normalizes a JSON-string body so the prepare result carries a real object', () => {
    const operation = prepareOperation({
      capability: 'economic_prepare_product_change',
      serviceId: 'products',
      method: 'PUT',
      pathTemplate: '/products/{number}',
      pathParams: { number: 1020 },
      body: '{"productNumber":"1020","name":"Widget"}',
      reason: 'Client stringified the body before sending it',
    });

    expect(operation.body).toEqual({ productNumber: '1020', name: 'Widget' });
  });

  it('verifies a hash across the object and JSON-string forms of the same body', () => {
    const operation = prepareOperation({
      capability: 'economic_prepare_product_change',
      serviceId: 'products',
      method: 'PUT',
      pathTemplate: '/products/{number}',
      pathParams: { number: 1020 },
      body: { productNumber: '1020', name: 'Widget' },
      reason: 'Create then commit round trip',
    });

    // Simulates a client that re-stringifies the body when it echoes the
    // prepared operation back for commit — the hash must still match, and
    // the returned operation must carry a real object, not the string.
    const restringified = { ...operation, body: JSON.stringify(operation.body) };
    const verified = verifyPreparedOperation(restringified);

    expect(verified.body).toEqual({ productNumber: '1020', name: 'Widget' });
  });
});
