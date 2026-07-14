import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { EconomicClient, type EconomicClientOptions } from './economic/client.js';
import { registerEconomicTools } from './tools/economic.js';

export interface CreateServerOptions {
  client?: EconomicClient;
  clientOptions?: EconomicClientOptions;
}

export function createServer(options: CreateServerOptions = {}): McpServer {
  const server = new McpServer({
    name: 'e-conomic',
    version: '0.5.1',
  });

  const client = options.client ?? new EconomicClient(options.clientOptions);
  registerEconomicTools(server, client);

  return server;
}
