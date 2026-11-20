import { afterEach, describe, expect, it } from 'vitest';
import { basePolicy, checkPolicy } from '../src/economic/policy.js';
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
