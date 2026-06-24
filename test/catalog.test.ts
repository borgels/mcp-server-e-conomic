import { describe, expect, it } from 'vitest';
import {
  ENDPOINT_OPERATIONS,
  ECONOMIC_SERVICES,
  findEndpoint,
  getSchemaSummary,
  searchCapabilities,
} from '../src/economic/catalog.js';
import { materializePath } from '../src/economic/endpoints.js';

describe('e-conomic catalog', () => {
  it('lists current official API areas', () => {
    expect(ECONOMIC_SERVICES.map(service => service.id)).toEqual(
      expect.arrayContaining([
        'rest',
        'customers',
        'products',
        'accounts',
        'projects',
        'journals',
        'q2c',
        'suppliers',
        'subscriptions',
        'dimensions',
        'documents',
        'booked-entries',
        'accounting-years',
        'budgets',
        'webhooks',
      ]),
    );
  });

  it('searches curated tools and endpoint capabilities', () => {
    const results = searchCapabilities('customer');

    expect(results.some(result => result.id === 'economic_get_customer_overview')).toBe(true);
    expect(results.some(result => result.id.startsWith('endpoint.customers.'))).toBe(true);
  });

  it('allowlists and materializes endpoint templates', () => {
    const endpoint = findEndpoint('customers', 'GET', '/Customers/{number}');

    expect(endpoint.risk).toBe('read');
    expect(materializePath(endpoint, { number: 42 })).toBe('/Customers/42');
  });

  it('allowlists project add-on write endpoints', () => {
    const project = findEndpoint('projects', 'POST', '/Projects');
    expect(project.risk).toBe('commit');

    const projectGroup = findEndpoint('projects', 'POST', '/ProjectGroups');
    expect(projectGroup.serviceId).toBe('projects');

    const employee = findEndpoint('projects', 'POST', '/Employees');
    expect(employee.method).toBe('POST');

    const productGroup = findEndpoint('products', 'POST', '/productgroups');
    expect(productGroup.serviceId).toBe('products');
  });

  it('summarizes schemas by service', () => {
    expect(getSchemaSummary('accounts')).toMatchObject({
      serviceId: 'accounts',
      resources: expect.arrayContaining(['Accounts']),
    });
  });

  it('contains a substantial endpoint coverage layer', () => {
    expect(ENDPOINT_OPERATIONS.length).toBeGreaterThan(100);
  });
});
