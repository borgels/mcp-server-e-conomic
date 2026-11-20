// System check against e-conomic's public demo agreement (both tokens are the
// word "demo", as e-conomic's documentation says; the agreement has the
// SuperUser role and is read-only for us). Calls every read tool of ./gateway
// on every target it may read, and prints one line per call: never the data.
// Run with `npm run check:demo`. Needs network access; not part of `npm test`.
import { createEconomicGateway, economicToolCatalog, type GatewayJsonObject } from '../src/gateway.js';

// Targets the demo agreement does not have data or a module for. Listed so a
// new failure stands out.
const EXPECTED_MISSING = new Set<string>(process.env.ECONOMIC_DEMO_EXPECTED_MISSING?.split(',') ?? []);

async function main(): Promise<void> {
  const gateway = createEconomicGateway({ appSecretToken: 'demo', agreementGrantToken: 'demo' });
  let failed = 0;
  for (const tool of economicToolCatalog) {
    if (tool.riskLevel !== 'read' || tool.broad) continue;
    const schema = tool.inputSchema as { properties?: { serviceId?: { description?: string } } };
    const pairs = /pairs: ([^.]+)\./.exec(schema.properties?.serviceId?.description ?? '')?.[1]?.split(', ') ?? [''];
    for (const pair of pairs) {
      const [serviceId, resource] = pair ? pair.split(':') : [];
      const query: GatewayJsonObject = serviceId === 'rest' ? { pagesize: 1 } : { pageSize: 1 };
      const input: GatewayJsonObject = serviceId && resource ? { serviceId, resource, query } : {};
      const result = await gateway.callTool(tool.name, input);
      const text = result.content[0]?.text.split('\n\n')[0] ?? '';
      const key = `${tool.name} ${pair}`.trim();
      if (result.isError && !EXPECTED_MISSING.has(key)) failed += 1;
      console.log(`${result.isError ? 'FAIL' : 'ok  '} ${key}: ${text.slice(0, 160)}`);
    }
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
