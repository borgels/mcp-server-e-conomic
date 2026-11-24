// The app roles per resource (src/economic/app-roles.ts) are e-conomic's own, operation by operation: the fixture
// holds what its OpenAPI documents for the three module APIs say (test/app-roles-fixture.ts writes it).
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ECONOMIC_APP_ROLES, appRoleKey, economicAppRolesFor } from '../src/economic/app-roles.js';
import { ECONOMIC_SERVICES } from '../src/economic/catalog.js';

interface Fixture {
  read: string;
  apis: Record<string, { document: string; version: string; operations: Record<string, string[]> }>;
}

const fixture = JSON.parse(readFileSync(new URL('./fixtures/economic-app-roles.json', import.meta.url), 'utf8')) as Fixture;
const APIS = ['projects', 'subscriptions', 'dimensions'] as const;
const sorted = (roles: readonly string[] | undefined) => (roles ? [...roles].sort() : undefined);

describe('the app roles e-conomic documents', () => {
  it('are read from the documents of the versions the catalog pins', () => {
    expect(Object.keys(fixture.apis).sort()).toEqual([...APIS].sort());
    for (const id of APIS) {
      const service = ECONOMIC_SERVICES.find(candidate => candidate.id === id)!;
      expect(fixture.apis[id]!.version, id).toBe(service.version);
      expect(fixture.apis[id]!.document, id).toBe(`https://apis.e-conomic.com/${service.servicePath!.split('/')[0]}/openapi.json`);
    }
    expect(Object.values(fixture.apis).map(api => Object.keys(api.operations).length)).toEqual([98, 22, 62]);
  });

  it('are the table’s for every operation of the three documents', () => {
    for (const id of APIS) {
      for (const [operation, roles] of Object.entries(fixture.apis[id]!.operations)) {
        const path = operation.slice(operation.indexOf(' ') + 1);
        expect(sorted(economicAppRolesFor(id, path)), `${id} ${operation}`).toEqual(roles);
      }
    }
  });

  it('the table names no resource the documents do not have', () => {
    for (const id of APIS) {
      const paths = Object.keys(fixture.apis[id]!.operations).map(operation => operation.slice(operation.indexOf(' ') + 1));
      for (const resource of Object.keys(ECONOMIC_APP_ROLES[id])) {
        expect(paths.some(path => path === `/${resource}` || path.startsWith(`/${resource}/`)), `${id} ${resource}`).toBe(true);
      }
    }
  });

  it('are known for every resource of the three services the catalog reads', () => {
    for (const id of APIS) {
      for (const resource of ECONOMIC_SERVICES.find(candidate => candidate.id === id)!.resources) {
        expect(economicAppRolesFor(id, `/${resource}/paged`), `${id} ${resource}`).toBeDefined();
      }
    }
  });

  it('differ by resource where e-conomic says so', () => {
    // The dimensions themselves are open to every role; what they are set on follows the role of that record.
    expect(sorted(economicAppRolesFor('dimensions', '/dimensions/paged'))).toEqual(['Bookkeeping', 'ProjectEmployee', 'Sales', 'SuperUser']);
    expect(sorted(economicAppRolesFor('dimensions', '/values/1/2'))).toEqual(['Bookkeeping', 'ProjectEmployee', 'Sales', 'SuperUser']);
    expect(sorted(economicAppRolesFor('dimensions', '/distributions/paged'))).toEqual(['Bookkeeping', 'ProjectEmployee', 'Sales', 'SuperUser']);
    expect(sorted(economicAppRolesFor('dimensions', '/dimension-data/draft-entries/paged'))).toEqual(['Bookkeeping', 'SuperUser']);
    expect(sorted(economicAppRolesFor('dimensions', '/dimension-data/booked-entries'))).toEqual(['Bookkeeping', 'SuperUser']);
    expect(sorted(economicAppRolesFor('dimensions', '/dimension-data/accounts'))).toEqual(['Bookkeeping', 'SuperUser']);
    expect(sorted(economicAppRolesFor('dimensions', '/dimension-data/sales-document-lines'))).toEqual(['Sales', 'SuperUser']);
    expect(sorted(economicAppRolesFor('dimensions', '/dimension-data/booked-invoice-lines/paged'))).toEqual(['Sales', 'SuperUser']);
    expect(sorted(economicAppRolesFor('projects', '/Projects/paged'))).toEqual(['ProjectEmployee', 'SuperUser']);
    expect(sorted(economicAppRolesFor('projects', '/TimeEntries/5'))).toEqual(['ProjectEmployee', 'SuperUser']);
    expect(sorted(economicAppRolesFor('projects', '/Employees'))).toEqual(['Sales', 'SuperUser']);
    expect(sorted(economicAppRolesFor('projects', '/EmployeeGroups/paged'))).toEqual(['Sales', 'SuperUser']);
    expect(sorted(economicAppRolesFor('subscriptions', '/Subscribers'))).toEqual(['Sales', 'SuperUser']);
    expect(sorted(economicAppRolesFor('subscriptions', '/subscriptions/3/lines'))).toEqual(['Sales', 'SuperUser']);
  });

  it('for the two classic REST resources are the rows of e-conomic’s table of roles', () => {
    // https://www.e-conomic.com/developer/permissions: Department (Superuser, Bookkeeping, Sales) and
    // DistributionKey (Superuser, Bookkeeping).
    expect(sorted(economicAppRolesFor('rest', '/departments/3'))).toEqual(['Bookkeeping', 'Sales', 'SuperUser']);
    expect(sorted(economicAppRolesFor('rest', '/departmental-distributions'))).toEqual(['Bookkeeping', 'SuperUser']);
    expect(Object.keys(ECONOMIC_APP_ROLES.rest)).toEqual(['departments', 'departmental-distributions']);
  });

  it('are found without regard to case, a query or the rest of the path, and never guessed', () => {
    expect(economicAppRolesFor('projects', '/projects/paged?pagesize=1')).toBe(economicAppRolesFor('projects', '/Projects'));
    expect(economicAppRolesFor('dimensions', 'dimension-data/Draft-Entries')).toBe(economicAppRolesFor('dimensions', '/dimension-data/draft-entries'));
    for (const [service, path] of [
      ['dimensions', '/dimension-data'],
      ['dimensions', '/dimension-data/unknown'],
      ['dimensions', '/'],
      ['dimensions', ''],
      ['projects', '/Unknown/paged'],
      ['rest', '/customers'],
      ['customers', '/Customers'],
      ['constructor', '/Projects'],
      ['__proto__', '/Projects'],
    ] as const) {
      expect(economicAppRolesFor(service, path), `${service} ${path}`).toBeUndefined();
    }
  });

  it('are compared by name without regard to case and spaces', () => {
    expect(appRoleKey('Project Employee')).toBe(appRoleKey('ProjectEmployee'));
    expect(appRoleKey('superuser')).toBe(appRoleKey('SuperUser'));
    expect(appRoleKey(undefined)).toBe('');
    expect(appRoleKey(2)).toBe('');
  });
});
