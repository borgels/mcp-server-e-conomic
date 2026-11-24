// Writes test/fixtures/economic-app-roles.json: the app roles e-conomic's OpenAPI documents name for every
// operation of the three module APIs (npm run fixture:app-roles). Run it when a pinned version changes
// (src/economic/catalog.ts); test/app-roles.test.ts then holds src/economic/app-roles.ts to the new file.
//
// The documents name the roles on each tag ("**Required application roles:** SuperUser or Sales"), and each
// operation has one tag. An operation without a tag, with several, or with a tag that names no roles stops the run:
// the table must not be written from a document it cannot read.
import { writeFile } from 'node:fs/promises';
import { ECONOMIC_SERVICES } from '../src/economic/catalog.js';

const APIS = ['projects', 'subscriptions', 'dimensions'] as const;
const ROLES = /\*\*Required application roles:\*\*\s*([A-Za-z ]+?)\s*(?:\[|$)/m;
const METHODS = new Set(['get', 'put', 'post', 'delete', 'patch']);

interface OpenApiDocument {
  info: { version: string };
  tags: Array<{ name: string; description?: string }>;
  paths: Record<string, Record<string, { tags?: string[] }>>;
}

const apis: Record<string, { document: string; version: string; operations: Record<string, string[]> }> = {};
for (const id of APIS) {
  const service = ECONOMIC_SERVICES.find(candidate => candidate.id === id)!;
  const name = service.servicePath!.split('/')[0]!;
  const url = `https://apis.e-conomic.com/${name}/openapi.json`;
  const response = await fetch(url, { signal: AbortSignal.timeout(60_000) });
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  const document = (await response.json()) as OpenApiDocument;
  if (document.info.version !== service.version) {
    throw new Error(`${url}: version ${document.info.version}, the catalog pins ${service.version}`);
  }
  const rolesOfTag = new Map<string, string[]>();
  for (const tag of document.tags) {
    const found = ROLES.exec(tag.description ?? '');
    if (found) rolesOfTag.set(tag.name, found[1]!.split(/\s+or\s+/).sort());
  }
  const operations: Record<string, string[]> = {};
  for (const path of Object.keys(document.paths).sort()) {
    for (const [method, operation] of Object.entries(document.paths[path]!)) {
      if (!METHODS.has(method)) continue;
      const tags = operation.tags ?? [];
      const roles = tags.length === 1 ? rolesOfTag.get(tags[0]!) : undefined;
      if (!roles) throw new Error(`${url}: no roles for ${method.toUpperCase()} ${path} (tags ${JSON.stringify(tags)})`);
      operations[`${method.toUpperCase()} ${path}`] = roles;
    }
  }
  apis[id] = { document: url, version: document.info.version, operations };
}

const target = new URL('./fixtures/economic-app-roles.json', import.meta.url);
// One operation per line, so a change in a document reads as a change of lines.
const text = JSON.stringify({ read: new Date().toISOString().slice(0, 10), apis }, null, 2).replace(
  /\[\s+([^\]]*?)\s+\]/g,
  (_, roles: string) => `[${roles.replace(/\s+/g, ' ')}]`,
);
await writeFile(target, `${text}\n`);
console.log(Object.entries(apis).map(([id, api]) => `${id} ${api.version}: ${Object.keys(api.operations).length} operations`).join('\n'));
