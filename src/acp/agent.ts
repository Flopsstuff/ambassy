/**
 * A2A server whose executor is a real coding agent instead of a stub.
 *
 * Two protocols meet here. Upstream is A2A: a stateful task, streamed status updates,
 * an artifact at the end. Downstream is ACP: an adapter subprocess that streams message
 * chunks, tool calls and plans. The translation between them lives in `executor.ts`;
 * this file is the bootstrap — environment, backend, handshake, card, port.
 *
 * The backend is chosen by the launch command: `yarn agent:claude` / `yarn agent:codex`.
 */
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { A2A_PROTOCOL_VERSION, AGENT_CARD_PATH, type AgentCard } from '@a2a-js/sdk';
import { DefaultRequestHandler, InMemoryTaskStore } from '@a2a-js/sdk/server';
import { agentCardHandler, jsonRpcHandler, UserBuilder } from '@a2a-js/sdk/server/express';
import { AcpRegistry, BACKENDS, type Backend, type BackendId } from './client.ts';
import { AcpExecutor } from './executor.ts';
import { openLogs } from './log.ts';
import { VERSION } from '../version.ts';

// Node 23 reads .env by itself; a missing file is not an error, the defaults below suffice.
const ENV_FILE = fileURLToPath(new URL('../../.env', import.meta.url));
if (existsSync(ENV_FILE)) process.loadEnvFile(ENV_FILE);

const BACKEND_ID = (process.env.ACP_AGENT ?? '') as BackendId;
if (!BACKENDS[BACKEND_ID]) {
  console.error(`Set ACP_AGENT to one of: ${Object.keys(BACKENDS).join(', ')} — use yarn agent:claude / yarn agent:codex`);
  process.exit(1);
}
const backend: Backend = BACKENDS[BACKEND_ID];

// `||` rather than `??`: a key left blank in .env arrives as '', and `??` would take it
// as a value — `LOG_DIR=` became `mkdir ''` and killed the server on startup. Blank means
// unset. `ACP_CWD` keeps `??` because there '' is a real answer: a sandbox per conversation.
const PORT = Number(process.env.PORT || 41241);
// Loopback by default, and deliberately so: this agent runs `UserBuilder.noAuthentication`,
// so a wider bind puts a real coding agent on the network with nothing in front of it.
// The MCP bridge is the side meant to face the network, and it has a bearer token.
const HOST = process.env.HOST || '127.0.0.1';
// The URL the agent advertises in its card. Override it to route clients through the wire-tap.
const PUBLIC_URL = process.env.PUBLIC_URL || `http://${HOST}:${PORT}/`;
// What the card calls this agent. AGENT_NAME replaces the whole default rather than standing in
// for `backend.label` inside it: `(via ACP)` is true of every instance of this bridge, so it
// separates none of them, and which backend answers is still on the card twice — in the
// description built from the adapter's own `initialize`, and in the skill's tags. A name an
// operator set is also a name a client config can pin, which a decorated one would not be.
const AGENT_NAME = process.env.AGENT_NAME || `${backend.label} (via ACP)`;
// Empty means a throwaway sandbox per conversation — see client.ts.
const ACP_CWD = process.env.ACP_CWD ?? '';
const ACP_ALLOW_EXECUTE = process.env.ACP_ALLOW_EXECUTE === 'true';
const ACP_IDLE_TIMEOUT_MS = Number(process.env.ACP_IDLE_TIMEOUT_MS || 300_000);
const LOG_DIR = process.env.LOG_DIR || fileURLToPath(new URL('../../logs/', import.meta.url));
const LOG_MAX_BYTES = Number(process.env.LOG_MAX_BYTES || 5_000_000);
const LOG_MAX_FILES = Number(process.env.LOG_MAX_FILES || 5);

const logs = openLogs({ dir: LOG_DIR, maxBytes: LOG_MAX_BYTES, maxFiles: LOG_MAX_FILES });

// --- Agent Card: built from the adapter's own answer to `initialize` ---

const registry = new AcpRegistry({
  backend,
  cwdOverride: ACP_CWD,
  allowExecute: ACP_ALLOW_EXECUTE,
  idleTimeoutMs: ACP_IDLE_TIMEOUT_MS,
  logs,
});

console.log(`Probing ${backend.bin}…`);
const handshake = await registry.handshake();
const downstream = handshake.agentInfo;
console.log(
  `  ⚙ ${downstream?.title ?? backend.label} ${downstream?.version ?? ''} ` +
    `(ACP protocol ${handshake.protocolVersion}), auth methods: ${handshake.authMethods?.length ?? 0}`,
);

const agentCard: AgentCard = {
  name: AGENT_NAME,
  // The adapter's name and version live here rather than in `version`, which names this bridge:
  // a caller reading the card is told what it is talking to, then what is behind it.
  description:
    `An A2A front for ${downstream?.name ?? backend.bin}${downstream?.version ? ` ${downstream.version}` : ''}: ` +
    'the task is forwarded to a real coding agent over ACP.',
  supportedInterfaces: [
    {
      url: PUBLIC_URL,
      protocolBinding: 'JSONRPC',
      tenant: '',
      protocolVersion: A2A_PROTOCOL_VERSION,
    },
  ],
  provider: { organization: 'Flopsstuff', url: 'https://example.local' },
  version: VERSION,
  capabilities: {
    streaming: true,
    pushNotifications: false,
    extensions: [],
    extendedAgentCard: false,
  },
  securitySchemes: {},
  securityRequirements: [],
  defaultInputModes: ['text'],
  defaultOutputModes: ['text', 'data'],
  skills: [
    {
      id: 'acp_prompt',
      name: 'Coding agent',
      description: `Forwards the request to ${downstream?.title ?? backend.label} and streams back its progress and answer.`,
      tags: ['code', 'acp', backend.id],
      examples: ['Create hello.txt with a greeting', 'Explain what this directory contains'],
      inputModes: ['text'],
      outputModes: ['text', 'data'],
      securityRequirements: [],
    },
  ],
  documentationUrl: '',
  signatures: [],
};

const requestHandler = new DefaultRequestHandler(
  agentCard,
  new InMemoryTaskStore(),
  new AcpExecutor(registry, logs, backend),
);

const app = express();
app.use((req, _res, next) => {
  console.log(`  ← ${req.method} ${req.originalUrl}`);
  next();
});
app.use(`/${AGENT_CARD_PATH}`, agentCardHandler({ agentCardProvider: requestHandler }));
app.use(jsonRpcHandler({ requestHandler, userBuilder: UserBuilder.noAuthentication }));

registry.startReaper();

app.listen(PORT, HOST, () => {
  console.log(`${agentCard.name} listening on http://${HOST}:${PORT}`);
  console.log(`Agent Card:          http://${HOST}:${PORT}/${AGENT_CARD_PATH}`);
  console.log(`Session root:        ${ACP_CWD || 'a fresh sandbox per conversation'}`);
  console.log(`Logs:                ${logs.dir} (calls.jsonl, work.jsonl)`);
});

const shutdown = async (signal: string): Promise<void> => {
  console.log(`\n${signal}: stopping ${registry.size} adapter(s)…`);
  await registry.disposeAll();
  process.exit(0);
};
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
