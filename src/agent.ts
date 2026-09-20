/**
 * A2A server: a minimal agent showing what the protocol is actually for —
 * a stateful task with a multi-turn conversation (INPUT_REQUIRED), streamed
 * status updates, and an artifact as the result.
 *
 * The "Revisor" agent: computes statistics over the text it is given. Its logic lives in
 * `src/revisor.ts`; this file is the bootstrap — environment, card, transport, port.
 */
import express from 'express';
import { A2A_PROTOCOL_VERSION, AGENT_CARD_PATH, type AgentCard } from '@a2a-js/sdk';
import { DefaultRequestHandler, InMemoryTaskStore } from '@a2a-js/sdk/server';
import { agentCardHandler, jsonRpcHandler, UserBuilder } from '@a2a-js/sdk/server/express';
import { RevisorExecutor } from './revisor.ts';
import { VERSION } from './version.ts';

const PORT = Number(process.env.PORT || 41241);
// Loopback by default: the agent runs `UserBuilder.noAuthentication`, so a wider bind
// hands it to anyone on the network. Set HOST explicitly to open it up.
const HOST = process.env.HOST || '127.0.0.1';
// The URL the agent advertises in its card. Override it to route clients through the wire-tap.
const PUBLIC_URL = process.env.PUBLIC_URL || `http://${HOST}:${PORT}/`;
// What the card calls this agent — the one field a caller has to tell two agents apart, since
// discovery starts at the card and nothing else in it is a name. Blank keeps `Revisor`, so a
// client config that pins the old one still matches. Unlike the two bridges this file reads no
// .env, so here the value comes from the shell or from the service unit.
const AGENT_NAME = process.env.AGENT_NAME || 'Revisor';

// --- Agent Card: the business card every interaction starts from ---

const agentCard: AgentCard = {
  name: AGENT_NAME,
  description: 'Computes text statistics. A demo agent for learning A2A v1.0.',
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
      id: 'text_stats',
      name: 'Text statistics',
      description: 'Words, characters, sentences and the most frequent words.',
      tags: ['text', 'analysis'],
      examples: ['Count the words in this paragraph'],
      inputModes: ['text'],
      outputModes: ['text', 'data'],
      securityRequirements: [],
    },
  ],
  documentationUrl: '',
  signatures: [],
};

const requestHandler = new DefaultRequestHandler(agentCard, new InMemoryTaskStore(), new RevisorExecutor());

const app = express();
app.use((req, _res, next) => {
  console.log(`  ← ${req.method} ${req.originalUrl}`);
  next();
});
app.use(`/${AGENT_CARD_PATH}`, agentCardHandler({ agentCardProvider: requestHandler }));
app.use(jsonRpcHandler({ requestHandler, userBuilder: UserBuilder.noAuthentication }));

app.listen(PORT, HOST, () => {
  console.log(`${AGENT_NAME} listening on http://${HOST}:${PORT}`);
  console.log(`Agent Card:          http://${HOST}:${PORT}/${AGENT_CARD_PATH}`);
});
