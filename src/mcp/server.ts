/**
 * The MCP endpoint that fronts an A2A agent, so a calling agent can reach it as a tool
 * instead of by hand with curl.
 *
 * It is an A2A *client* and nothing else: it never imports `src/acp/`, and talks to the
 * agent over the network like any other peer would. That keeps the bridge replaceable —
 * point `A2A_URL` at someone else's agent and this file does not change.
 *
 * Stateless per request: a fresh server and transport are built for each HTTP request
 * and disposed when it closes. There is no session state worth keeping between calls —
 * the conversation lives in the A2A `contextId`, which the caller passes back in, and the
 * task lives on the agent, which is what makes `a2a_task` a real recovery path.
 *
 * Each call blocks until the agent reaches a terminal state. That is deliberate: a client
 * that backgrounds a long tool call and notifies on completion already solves the problem
 * a polling handle would solve, and it solves it without inventing a second task registry
 * next to the one A2A already specifies.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createMcpExpressApp } from '@modelcontextprotocol/express';
import { NodeStreamableHTTPServerTransport } from '@modelcontextprotocol/node';
import { McpServer } from '@modelcontextprotocol/server';
import type { Request, Response } from 'express';

import { openLogs } from '../acp/log.ts';
import { VERSION } from '../version.ts';
import { A2APool } from './a2a.ts';
import { bearerGuard, mintToken, persistToken } from './auth.ts';
import { registerTools } from './tools.ts';

const ENV_FILE = fileURLToPath(new URL('../../.env', import.meta.url));
if (existsSync(ENV_FILE)) process.loadEnvFile(ENV_FILE);

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const TOKEN_FILE = join(ROOT, '.mcp-token');
const MCP_PATH = '/mcp';

// `||` rather than `??` throughout, and the difference is not cosmetic: a key left blank
// in .env arrives as '', which `??` accepts as a value. That turns `LOG_DIR=` into
// `mkdir ''` and `MCP_PORT=` into a random port. Blank means unset. The exceptions below
// keep `??` because '' is a real answer there — no aliases, no allowlist, no pinned token.
const PORT = Number(process.env.MCP_PORT || 41243);
const HOST = process.env.MCP_HOST || '127.0.0.1';
const HEARTBEAT_MS = Number(process.env.MCP_HEARTBEAT_MS || 60_000);
const SILENCE_MS = Number(process.env.MCP_UPSTREAM_SILENCE_MS || 600_000);
// The silence gate covers `a2a_ask` and nothing else, so the operations that do not stream
// need deadlines of their own. Discovery is separate from the calls that follow it because
// it is shared: it is a handshake several callers wait on, not one caller's request.
const DISCOVERY_MS = Number(process.env.MCP_DISCOVERY_TIMEOUT_MS || 20_000);
const REQUEST_MS = Number(process.env.MCP_REQUEST_TIMEOUT_MS || 30_000);
const A2A_URL = process.env.A2A_URL || 'http://localhost:41241/';
const A2A_AGENTS = process.env.A2A_AGENTS ?? '';
const ALLOWED_HOSTS = (process.env.MCP_ALLOWED_HOSTS ?? '').split(',').map((h) => h.trim()).filter(Boolean);
const LOG_DIR = process.env.LOG_DIR || fileURLToPath(new URL('../../logs/', import.meta.url));
const LOG_MAX_BYTES = Number(process.env.LOG_MAX_BYTES || 5_000_000);
const LOG_MAX_FILES = Number(process.env.LOG_MAX_FILES || 5);
// What this endpoint calls itself in the `serverInfo` of every `initialize` response — the only
// name a calling agent sees for it, and the one thing that separates two bridges in one client
// config. The same key as the Agent Card's name on purpose: from the caller's side both are the
// name of the agent it is reaching, and a bridge announcing one thing while the agent behind it
// announces another would be a puzzle, not a distinction. Blank keeps `ambassy-mcp`.
const AGENT_NAME = process.env.AGENT_NAME || 'ambassy-mcp';

/** `A2A_AGENTS` wins when set; otherwise the single agent at `A2A_URL` needs no alias. */
const agents = ((): Record<string, string> => {
  if (!A2A_AGENTS) return { default: A2A_URL };
  try {
    return JSON.parse(A2A_AGENTS) as Record<string, string>;
  } catch (err) {
    console.error(`  ⨯ A2A_AGENTS is not valid JSON: ${(err as Error).message}`);
    process.exit(1);
  }
})();

// A token pinned in the environment survives a restart, so the client config keeps
// working; a generated one has to be copied again each time the bridge comes up.
const pinned = process.env.MCP_TOKEN ?? '';
const token = pinned || mintToken();
if (!pinned) persistToken(TOKEN_FILE, token);

const logs = openLogs({ dir: LOG_DIR, maxBytes: LOG_MAX_BYTES, maxFiles: LOG_MAX_FILES });
const pool = new A2APool({ agents, logs, discoveryTimeoutMs: DISCOVERY_MS, requestTimeoutMs: REQUEST_MS });

// --- HTTP ---

const app = createMcpExpressApp({
  host: HOST,
  // Binding beyond loopback turns off the SDK's automatic DNS-rebinding protection,
  // so the allowlist has to be supplied explicitly in that case.
  ...(ALLOWED_HOSTS.length > 0 ? { allowedHosts: ALLOWED_HOSTS } : {}),
});

app.use(MCP_PATH, bearerGuard(token));

app.all(MCP_PATH, async (req: Request, res: Response) => {
  const server = new McpServer({ name: AGENT_NAME, version: VERSION });
  registerTools(server, { pool, logs, heartbeatMs: HEARTBEAT_MS, silenceLimitMs: SILENCE_MS });

  const transport = new NodeStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on('close', () => {
    void transport.close();
    void server.close();
  });

  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error(`  ⨯ ${req.method} ${MCP_PATH}: ${(err as Error).message}`);
    if (!res.headersSent) res.status(500).json({ error: 'internal error' });
  }
});

const url = `http://${HOST === '0.0.0.0' ? '127.0.0.1' : HOST}:${PORT}${MCP_PATH}`;

app.listen(PORT, HOST, () => {
  console.log('⚙ Ambassy MCP bridge');
  console.log(`  endpoint: ${url}${HOST === '0.0.0.0' ? '  (bound on 0.0.0.0)' : ''}`);
  for (const [alias, target] of Object.entries(agents)) console.log(`  agent:    ${alias} → ${target}`);
  console.log(`  logs:     ${logs.dir}`);
  console.log(pinned ? '  token:    taken from MCP_TOKEN' : `  token:    written to ${TOKEN_FILE} (mode 600)`);
  console.log();
  console.log(`  ${token}`);
  console.log();
  console.log('  Connect with:');
  console.log(`  claude mcp add --transport http ambassy ${url} --header "Authorization: Bearer ${token}"`);
  logs.call('mcp.listen', { port: PORT, host: HOST, agents: Object.keys(agents), pinnedToken: Boolean(pinned) });
});

const shutdown = (): void => {
  console.log('\n⚙ stopping');
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
