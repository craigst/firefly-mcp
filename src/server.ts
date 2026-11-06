import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { FireflyClient, type FireflyConfig } from './client.js';
import { registerTools, type ServerOpts } from './tools.js';

export const SERVER_NAME = 'firefly-mcp';
export const SERVER_VERSION = '1.0.0';

export function buildServer(cfg: FireflyConfig, opts: ServerOpts): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });
  const client = new FireflyClient(cfg);
  registerTools(server, client, opts);
  return server;
}
