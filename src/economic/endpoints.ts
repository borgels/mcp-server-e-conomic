import type { HttpMethod, QueryValue } from './client.js';
import { EconomicClient } from './client.js';
import { ECONOMIC_SERVICES, ENDPOINT_OPERATIONS, type EndpointOperation, findEndpoint, findService } from './catalog.js';
import { assertSafePathParam, encodePathParam } from './path-params.js';

export interface EndpointCallInput {
  serviceId: string;
  method: HttpMethod;
  pathTemplate: string;
  pathParams?: Record<string, string | number>;
  query?: Record<string, QueryValue>;
  body?: unknown;
  idempotencyKey?: string;
}

export async function callEndpoint(client: EconomicClient, input: EndpointCallInput): Promise<unknown> {
  const endpoint = findEndpoint(input.serviceId, input.method, input.pathTemplate);
  const service = findService(endpoint.serviceId);
  const path = materializePath(endpoint, input.pathParams);

  if (endpoint.surface === 'rest') {
    return client.rest(path, {
      method: endpoint.method,
      query: input.query,
      body: input.body,
      idempotencyKey: input.idempotencyKey,
    });
  }

  return client.openApi(service.servicePath, path, {
    method: endpoint.method,
    query: input.query,
    body: input.body,
    idempotencyKey: input.idempotencyKey,
  });
}

export function materializePath(
  endpoint: EndpointOperation,
  pathParams: Record<string, string | number> = {},
): string {
  return endpoint.pathTemplate.replace(/\{([^}]+)\}/g, (_, key: string) => {
    const value = pathParams[key];
    if (value === undefined || value === null || value === '') {
      throw new Error(`Missing path parameter "${key}" for ${endpoint.pathTemplate}`);
    }

    return encodePathParam(value, `path parameter "${key}"`);
  });
}

const SELF_URL_SURFACES: Record<string, 'rest' | 'openapi'> = {
  'restapi.e-conomic.com': 'rest',
  'apis.e-conomic.com': 'openapi',
};

/**
 * Maps an e-conomic `self` URL onto an allowlisted GET endpoint so it can be
 * dispatched through callEndpoint (configured base URLs, path-param guard)
 * instead of fetching an arbitrary caller-supplied URL with credentials.
 */
export function resolveSelfUrl(
  urlValue: string,
  query?: Record<string, QueryValue>,
): EndpointCallInput {
  let url: URL;
  try {
    url = new URL(urlValue);
  } catch {
    throw new Error('selfUrl is not a valid URL.');
  }

  const surface = SELF_URL_SURFACES[url.hostname];
  if (url.protocol !== 'https:' || url.port !== '' || url.username || url.password || !surface) {
    throw new Error(
      'selfUrl must be an https URL on restapi.e-conomic.com or apis.e-conomic.com (default port, no credentials).',
    );
  }

  const segments = url.pathname.split('/').slice(1);
  if (segments.length > 1 && segments[segments.length - 1] === '') {
    segments.pop();
  }

  let serviceIds: string[];
  let apiSegments: string[];
  if (surface === 'rest') {
    serviceIds = ECONOMIC_SERVICES.filter(service => service.surface === 'rest').map(service => service.id);
    apiSegments = segments;
  } else {
    const service = ECONOMIC_SERVICES.find(candidate => {
      if (candidate.surface !== 'openapi') return false;
      const prefix = candidate.servicePath.split('/');
      return prefix.every((part, index) => segments[index]?.toLowerCase() === part.toLowerCase());
    });
    if (!service) {
      throw new Error('selfUrl does not point to a supported e-conomic API service.');
    }
    serviceIds = [service.id];
    apiSegments = segments.slice(service.servicePath.split('/').length);
  }

  let decoded: string[];
  try {
    decoded = apiSegments.map(segment => decodeURIComponent(segment));
  } catch {
    throw new Error('selfUrl contains an invalid percent-encoding.');
  }

  let best: { endpoint: EndpointOperation; params: Record<string, string>; literals: number } | undefined;
  for (const endpoint of ENDPOINT_OPERATIONS) {
    if (endpoint.method !== 'GET' || !serviceIds.includes(endpoint.serviceId)) continue;
    const templateSegments = endpoint.pathTemplate.split('/').slice(1);
    if (templateSegments.length !== decoded.length) continue;

    const params: Record<string, string> = {};
    let literals = 0;
    const matches = templateSegments.every((templateSegment, index) => {
      const param = /^\{([^}]+)\}$/.exec(templateSegment);
      if (param) {
        params[param[1] as string] = decoded[index] as string;
        return true;
      }
      literals += 1;
      return templateSegment === apiSegments[index];
    });
    if (matches && (!best || literals > best.literals)) {
      best = { endpoint, params, literals };
    }
  }

  if (!best) {
    throw new Error('selfUrl does not match an allowlisted e-conomic read endpoint.');
  }

  for (const [key, value] of Object.entries(best.params)) {
    assertSafePathParam(value, `selfUrl path parameter "${key}"`);
  }

  const urlQuery: Record<string, QueryValue> = Object.fromEntries(url.searchParams.entries());
  const mergedQuery = { ...urlQuery, ...(query ?? {}) };

  return {
    serviceId: best.endpoint.serviceId,
    method: 'GET',
    pathTemplate: best.endpoint.pathTemplate,
    pathParams: Object.keys(best.params).length > 0 ? best.params : undefined,
    query: Object.keys(mergedQuery).length > 0 ? mergedQuery : undefined,
  };
}
