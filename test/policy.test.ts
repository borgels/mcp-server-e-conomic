import { afterEach, describe, expect, it } from 'vitest';
import { checkPolicy } from '../src/economic/policy.js';
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
