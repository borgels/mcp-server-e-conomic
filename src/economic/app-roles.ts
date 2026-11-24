// The app roles that reach each resource of the add-on modules' APIs, as e-conomic documents them.
//
// e-conomic limits what an app may reach by the roles asked for when the agreement's grant was issued, and answers a
// request outside them with HTTP 403. Its OpenAPI documents name the roles on each tag, as "Required application
// roles: SuperUser or ...", and every operation carries exactly one tag, so the roles follow the first segment of
// the path (the first two under /dimension-data). Read on 2026-11-24 from
//
//   https://apis.e-conomic.com/projectsapi/openapi.json        1.1.1
//   https://apis.e-conomic.com/subscriptionsapi/openapi.json   6.0.3
//   https://apis.e-conomic.com/dimensionsapi/openapi.json      5.3.1
//
// test/fixtures/economic-app-roles.json holds the roles of every operation of the three documents
// (npm run fixture:app-roles writes it), and test/app-roles.test.ts holds this table to it.
//
// The classic REST API has no such document. Its two resources here are from e-conomic's table of roles
// (https://www.e-conomic.com/developer/permissions, read on 2026-11-24): the row Department (Superuser,
// Bookkeeping, Sales) and the row DistributionKey (Superuser, Bookkeeping). Both rows give the path
// /departmental-distributions, so that path has the roles the two rows share.

export type EconomicAppRole = 'SuperUser' | 'Bookkeeping' | 'Sales' | 'ProjectEmployee';

const EVERY_ROLE: readonly EconomicAppRole[] = ['SuperUser', 'Bookkeeping', 'Sales', 'ProjectEmployee'];
const BOOKKEEPING: readonly EconomicAppRole[] = ['SuperUser', 'Bookkeeping'];
const SALES: readonly EconomicAppRole[] = ['SuperUser', 'Sales'];
const PROJECT: readonly EconomicAppRole[] = ['SuperUser', 'ProjectEmployee'];

/** The services whose resources have documented app roles here: the three module APIs, and classic REST. */
export type EconomicAppRoleService = 'projects' | 'subscriptions' | 'dimensions' | 'rest';

/**
 * Per service: the leading path of a resource, as e-conomic writes it, and the app roles that reach every
 * operation under it.
 */
export const ECONOMIC_APP_ROLES: Readonly<Record<EconomicAppRoleService, Readonly<Record<string, readonly EconomicAppRole[]>>>> = {
  projects: {
    Activities: PROJECT,
    ActivityGroups: PROJECT,
    CostTypeGroups: PROJECT,
    CostTypes: PROJECT,
    // Employees are also used on sales documents: the Sales role reaches them, the project role does not.
    EmployeeGroups: SALES,
    Employees: SALES,
    MileagePrices: PROJECT,
    Mileages: PROJECT,
    ProjectGroups: PROJECT,
    ProjectStatuses: PROJECT,
    Projects: PROJECT,
    TimeEntries: PROJECT,
    TimeEntryPrices: PROJECT,
    'project-activities': PROJECT,
    'project-customers': PROJECT,
    'project-employeegroups': PROJECT,
    'project-employees': PROJECT,
  },
  subscriptions: {
    Subscribers: SALES,
    Subscriptions: SALES,
    subscriptionlines: SALES,
  },
  dimensions: {
    dimensions: EVERY_ROLE,
    values: EVERY_ROLE,
    distributions: EVERY_ROLE,
    'dimension-data/accounts': BOOKKEEPING,
    'dimension-data/booked-entries': BOOKKEEPING,
    'dimension-data/budget-figures': BOOKKEEPING,
    'dimension-data/draft-entries': BOOKKEEPING,
    'dimension-data/booked-invoice-lines': SALES,
    'dimension-data/sales-document-lines': SALES,
  },
  rest: {
    departments: ['SuperUser', 'Bookkeeping', 'Sales'],
    'departmental-distributions': BOOKKEEPING,
  },
};

const BY_LOWER_CASE: Readonly<Record<string, ReadonlyMap<string, readonly EconomicAppRole[]>>> = Object.fromEntries(
  Object.entries(ECONOMIC_APP_ROLES).map(([service, resources]) => [
    service,
    new Map(Object.entries(resources).map(([resource, roles]) => [resource.toLowerCase(), roles])),
  ]),
);

/**
 * The app roles that reach a request, from its service and its path within the service (as
 * "/dimension-data/draft-entries/paged"; a query is ignored), or undefined when e-conomic's documents name none
 * for it. The longest leading path decides, without regard to case.
 */
export function economicAppRolesFor(serviceId: string, path: string): readonly EconomicAppRole[] | undefined {
  const resources = Object.hasOwn(BY_LOWER_CASE, serviceId) ? BY_LOWER_CASE[serviceId] : undefined;
  if (!resources) return undefined;
  const segments = (path.split(/[?#]/)[0] ?? '')
    .split('/')
    .filter(segment => segment !== '')
    .map(segment => segment.toLowerCase());
  for (let length = Math.min(segments.length, 2); length >= 1; length -= 1) {
    const roles = resources.get(segments.slice(0, length).join('/'));
    if (roles) return roles;
  }
  return undefined;
}

/** An app role's name as it is compared: "Project Employee" and "ProjectEmployee" are the same role. */
export function appRoleKey(name: unknown): string {
  return typeof name === 'string' ? name.replace(/\s+/g, '').toLowerCase() : '';
}
