#!/usr/bin/env node
/**
 * firefly-mcp — MCP server over a Firefly III personal-finance database.
 *
 * stdio transport (what the MCP gateway runs):
 *   FIREFLY_BASE_URL=http://10.10.254.13:8090 FIREFLY_TOKEN=... node dist/index.js
 *
 *   node dist/index.js --check   validate configuration without serving
 */
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { buildServer, SERVER_NAME, SERVER_VERSION } from './server.js';
import type { LeaveSpan } from './forecast.js';

function env(name: string, dflt?: string): string {
  const v = process.env[name];
  if (v === undefined || v === '') {
    if (dflt !== undefined) return dflt;
    throw new Error(`missing required env ${name}`);
  }
  return v;
}

function loadLeave(): LeaveSpan[] {
  const raw = process.env.FIREFLY_HOLIDAYS_JSON;
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed?.spans)) return parsed.spans as LeaveSpan[];
    if (Array.isArray(parsed)) return parsed as LeaveSpan[];
    return [];
  } catch {
    process.stderr.write(`${SERVER_NAME}: FIREFLY_HOLIDAYS_JSON is not valid JSON, ignoring\n`);
    return [];
  }
}

async function main(): Promise<void> {
  const check = process.argv.includes('--check');
  const baseUrl = env('FIREFLY_BASE_URL', process.env.FIREFLY_URL ?? 'http://10.10.254.13:8090');
  const token = env('FIREFLY_TOKEN', process.env.FIREFLY_III_ACCESS_TOKEN);
  const currentAccountId = env('FIREFLY_CURRENT_ACCOUNT_ID', '1');
  const paydayWeekday = Number(env('FIREFLY_PAYDAY_WEEKDAY', '4'));
  const defaultBuffer = Number(env('FIREFLY_BUFFER', '0'));
  const leaveSpans = loadLeave();

  if (check) {
    process.stderr.write(
      `${SERVER_NAME} ${SERVER_VERSION}\n` +
        `  base url        ${baseUrl}\n` +
        `  token           ${token ? `set (${token.length} chars)` : 'MISSING'}\n` +
        `  current account ${currentAccountId}\n` +
        `  payday weekday  ${paydayWeekday}\n` +
        `  buffer          ${defaultBuffer}\n` +
        `  leave spans     ${leaveSpans.length}\n`,
    );
    if (!token) process.exitCode = 1;
    return;
  }

  const server = buildServer(
    { baseUrl, token },
    { currentAccountId, paydayWeekday, defaultBuffer, leaveSpans },
  );
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write(`${SERVER_NAME} ${SERVER_VERSION} ready on stdio\n`);
}

main().catch((err) => {
  process.stderr.write(`${SERVER_NAME} fatal: ${(err as Error).message}\n`);
  process.exit(1);
});
