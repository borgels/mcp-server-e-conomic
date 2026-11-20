// System check against e-conomic's public demo agreement (both tokens are the
// word "demo", as e-conomic's documentation says; the agreement has the
// SuperUser role and is read-only for us). Calls every read tool of ./gateway
// on every target it may read, and prints one line per call: never the data.
// Run with `npm run check:demo`. Needs network access; not part of `npm test`.
import { createEconomicGateway, economicToolCatalog, type GatewayJsonObject } from '../src/gateway.js';

// Targets the demo agreement does not have data or a module for. Listed so a
// new failure stands out.
const EXPECTED_MISSING = new Set<string>(process.env.ECONOMIC_DEMO_EXPECTED_MISSING?.split(',') ?? []);

/** The summary line ends where the JSON starts (a blank line). */
const SUMMARY_END = String.fromCharCode(10, 10);

// Targets that need query parameters (the demo agreement's employee 1 and project 1).
const REQUIRED_QUERY: Record<string, GatewayJsonObject> = {
  'projects:Activities/allowed': { employeeNumber: 1, projectNumber: 1 },
  'projects:Projects/allowed': { employeeNumber: 1 },
};

async function main(): Promise<void> {
  const gateway = createEconomicGateway({ appSecretToken: 'demo', agreementGrantToken: 'demo' });
  let failed = 0;
  for (const tool of economicToolCatalog) {
    if (tool.riskLevel !== 'read' || tool.broad) continue;
    const schema = tool.inputSchema as { properties?: { serviceId?: { description?: string } } };
    const pairs = /pairs: ([^.]+)\./.exec(schema.properties?.serviceId?.description ?? '')?.[1]?.split(', ') ?? [''];
    for (const pair of pairs) {
      const [serviceId, resource] = pair ? pair.split(':') : [];
      const query: GatewayJsonObject = serviceId === 'rest' ? { pagesize: 1 } : { pageSize: 1, ...(REQUIRED_QUERY[pair] ?? {}) };
      const input: GatewayJsonObject = serviceId && resource ? { serviceId, resource, query } : {};
      const result = await gateway.callTool(tool.name, input);
      // Only the summary line or the HTTP status: never data, never an error body.
      const first = result.content[0]?.text.split('\n\n')[0] ?? '';
      const text = result.isError ? (/HTTP \d{3}/.exec(first)?.[0] ?? 'refused') : first;
      const key = `${tool.name} ${pair}`.trim();
      if (result.isError && !EXPECTED_MISSING.has(key)) failed += 1;
      console.log(`${result.isError ? 'FAIL' : 'ok  '} ${key}: ${text}`);
    }
  }
  // PDFs: the first attached document and the first booked invoice.
  const firstNumber = (content: unknown, key: string): number | undefined => {
    const list = Array.isArray(content) ? content : (content as { collection?: unknown[] } | undefined)?.collection;
    const value = (list?.[0] as Record<string, unknown> | undefined)?.[key];
    return typeof value === 'number' ? value : undefined;
  };
  // The attached document with the fewest pages among the first 20 (a PDF above 4 MB is refused).
  const documents = await gateway.callTool('get_document', { query: { pageSize: 20 } });
  const listed = Array.isArray(documents.structuredContent) ? [...documents.structuredContent] : [];
  listed.sort((a, b) => Number((a as { pageCount?: number }).pageCount ?? 0) - Number((b as { pageCount?: number }).pageCount ?? 0));
  const invoices = await gateway.callTool('invoice_overview', { query: { pagesize: 1 } });
  for (const [label, input] of [
    ['attached document', { number: firstNumber(listed, 'number') ?? 0, pdf: true }],
    ['booked invoice', { resource: 'invoices/booked', number: firstNumber(invoices.structuredContent, 'bookedInvoiceNumber') ?? 0, pdf: true }],
  ] as Array<[string, GatewayJsonObject]>) {
    const result = await gateway.callTool('get_document', input);
    const first = result.content[0]?.text.split(SUMMARY_END)[0] ?? '';
    if (result.isError) failed += 1;
    console.log(`${result.isError ? 'FAIL' : 'ok  '} get_document PDF of ${label}: ${result.isError ? (/HTTP \d{3}/.exec(first)?.[0] ?? 'refused') : first}`);
  }

  if (failed > 0) {
    console.error(`${failed} read call(s) failed against the demo agreement.`);
    process.exit(1);
  }
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
