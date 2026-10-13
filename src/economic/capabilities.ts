import type { HttpMethod } from './client.js';

/**
 * Fixed map of which endpoints each write capability may target. A prepare
 * tool can only produce operations on its own routes, and commit re-checks
 * the (signed) capability against the same map, so `allowedCapabilities` in
 * the write policy really restricts what can be written.
 */
export interface CapabilityRoute {
  serviceId: string;
  method: HttpMethod;
  pathTemplate: string;
}

type Verb = 'create' | 'upsert' | 'update' | 'delete';

const VERB_ROUTES: Record<Verb, { method: HttpMethod; item: boolean }> = {
  create: { method: 'POST', item: false },
  upsert: { method: 'PUT', item: false },
  update: { method: 'PUT', item: true },
  delete: { method: 'DELETE', item: true },
};

function resource(serviceId: string, name: string, verbs: Verb[]): CapabilityRoute[] {
  return verbs.map(verb => ({
    serviceId,
    method: VERB_ROUTES[verb].method,
    pathTemplate: VERB_ROUTES[verb].item ? `/${name}/{number}` : `/${name}`,
  }));
}

function route(serviceId: string, method: HttpMethod, pathTemplate: string): CapabilityRoute {
  return { serviceId, method, pathTemplate };
}

const ALL: Verb[] = ['create', 'upsert', 'update', 'delete'];
const COLLECTION_UPSERT: Verb[] = ['create', 'upsert', 'delete'];
const journalDraftRoutes = resource('journals', 'draft-entries', ALL);

export const CAPABILITY_ROUTES: Readonly<Record<string, readonly CapabilityRoute[]>> = {
  economic_prepare_customer_change: [
    ...resource('customers', 'Customers', ALL),
    ...resource('customers', 'Contacts', ALL),
    ...resource('customers', 'DeliveryLocations', ALL),
    route('rest', 'POST', '/customers'),
    route('rest', 'PUT', '/customers/{number}'),
  ],
  economic_prepare_supplier_change: [
    route('rest', 'POST', '/suppliers'),
    route('rest', 'PUT', '/suppliers/{number}'),
    ...resource('suppliers', 'Contacts', ALL),
  ],
  economic_prepare_product_change: [
    ...resource('products', 'products', ALL),
    route('rest', 'POST', '/products'),
    route('rest', 'PUT', '/products/{number}'),
  ],
  economic_prepare_product_group_change: resource('products', 'productgroups', ALL),
  economic_prepare_project_change: resource('projects', 'Projects', COLLECTION_UPSERT),
  economic_prepare_project_group_change: resource('projects', 'ProjectGroups', COLLECTION_UPSERT),
  economic_prepare_employee_change: resource('projects', 'Employees', COLLECTION_UPSERT),
  economic_prepare_time_entry: resource('projects', 'TimeEntries', ['create', 'delete']),
  economic_prepare_sales_document: [
    ...resource('q2c', 'invoices/drafts', ALL),
    ...resource('q2c', 'orders', ALL),
    ...resource('q2c', 'quotes', ALL),
    route('q2c', 'POST', '/invoices/drafts/{documentId}/lines/bulk'),
    route('rest', 'POST', '/invoices/drafts'),
  ],
  economic_prepare_journal_entry: journalDraftRoutes,
  economic_prepare_payment_registration: journalDraftRoutes,
  economic_prepare_booking: [route('journals', 'POST', '/journals/{journalNumber}/bookdraftentries')],
  economic_prepare_open_item_match: [route('booked-entries', 'POST', '/booked-entries/match')],
};

function normalize(pathTemplate: string): string {
  return pathTemplate.startsWith('/') ? pathTemplate : `/${pathTemplate}`;
}

export function isKnownCapability(capability: string): boolean {
  return Object.prototype.hasOwnProperty.call(CAPABILITY_ROUTES, capability);
}

/** Throws unless the capability is known and the route is one of its own. */
export function assertCapabilityRoute(capability: string, candidate: CapabilityRoute): void {
  if (!isKnownCapability(capability)) {
    throw new Error(`Unknown write capability: ${capability}`);
  }
  const allowed = (CAPABILITY_ROUTES[capability] ?? []).some(
    item =>
      item.serviceId === candidate.serviceId &&
      item.method === candidate.method &&
      item.pathTemplate === normalize(candidate.pathTemplate),
  );
  if (!allowed) {
    throw new Error(
      `${capability} cannot target ${candidate.method} ${candidate.serviceId}:${candidate.pathTemplate}.`,
    );
  }
}
