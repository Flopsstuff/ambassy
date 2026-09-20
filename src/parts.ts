/**
 * The A2A shapes both servers build by hand, in one place.
 *
 * `src/agent.ts` and `src/acp/agent.ts` are two different agents, but the wire between
 * them and a client is the same protocol, and they were carrying identical copies of
 * these five helpers. Copies drift: `Part` is a discriminated union whose `$case` is easy
 * to get subtly wrong, and a divergence would show up as a message the other side reads
 * as empty rather than as an error anyone can see.
 *
 * Nothing here talks to the network or keeps state — it is the vocabulary, not the agent.
 */
import { Role, type Message, type Part, type TaskState, type TaskStatusUpdateEvent } from '@a2a-js/sdk';

/**
 * In v1.0 a Part is a discriminated union on `content.$case` — `{ content: { $case:
 * 'text', value } }`. On the wire it is flat (`{"text": "…"}`), because the schema is
 * generated from a protobuf `oneof`; the SDK shape is what every caller here sees.
 */
export const textPart = (value: string): Part => ({
  content: { $case: 'text', value },
  metadata: undefined,
  filename: '',
  mediaType: 'text/plain',
});

/** The structured half of an artifact: a machine reads this instead of parsing prose. */
export const dataPart = (value: unknown): Part => ({
  content: { $case: 'data', value },
  metadata: undefined,
  filename: '',
  mediaType: 'application/json',
});

export const agentMessage = (taskId: string, contextId: string, parts: Part[]): Message => ({
  messageId: crypto.randomUUID(),
  contextId,
  taskId,
  role: Role.ROLE_AGENT,
  parts,
  metadata: {},
  extensions: [],
  referenceTaskIds: [],
});

export const statusUpdate = (
  taskId: string,
  contextId: string,
  state: TaskState,
  message?: Message,
): TaskStatusUpdateEvent => ({
  taskId,
  contextId,
  status: { state, message, timestamp: new Date().toISOString() },
  metadata: {},
});

/** Everything the user said, as one string. Non-text parts are simply not text. */
export const readText = (message: Message): string =>
  message.parts
    .map((p) => (p.content?.$case === 'text' ? p.content.value : ''))
    .join(' ')
    .trim();
