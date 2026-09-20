/**
 * The A2A side of the bridge: one pool of clients, one method per tool.
 *
 * Clients are built lazily and kept, because `createFromUrl` fetches the agent card
 * and negotiates a transport on every call — work worth doing once per agent rather
 * than once per tool call.
 *
 * Everything the caller needs from a turn is flattened into `AskResult`. The tool
 * layer should not have to know that `Part` is a discriminated union in TypeScript
 * and a flat object on the wire, nor that `TaskState` is a numeric enum; those are
 * A2A's shapes, and they stop here.
 */
import { AGENT_CARD_PATH, A2A_PROTOCOL_VERSION, Role, TaskState } from '@a2a-js/sdk';
import type { AgentCard, Message, Part, StreamResponse, Task } from '@a2a-js/sdk';
import { ClientFactory } from '@a2a-js/sdk/client';
import type { Client } from '@a2a-js/sdk/client';

import type { Logs } from '../acp/log.ts';

export interface A2APoolOptions {
  /** Agents by alias; the alias is what a tool caller names. */
  agents: Record<string, string>;
  logs: Logs;
}

/** One forwarded step of a turn, already reduced to something printable. */
export interface AskUpdate {
  kind: 'task' | 'status' | 'artifact';
  state: TaskState | null;
  text: string;
}

export interface AskResult {
  taskId: string;
  contextId: string;
  state: TaskState;
  /** Concatenated text of the artifacts the agent produced. */
  answer: string;
  /** The structured part of the artifact, when the agent sent one. */
  data: unknown;
  /** Set when the turn ended in INPUT_REQUIRED: what the agent is waiting to hear. */
  question: string | null;
}

export class UnknownAgentError extends Error {
  constructor(alias: string, known: string[]) {
    super(`unknown agent "${alias}" — configured: ${known.join(', ') || '(none)'}`);
    this.name = 'UnknownAgentError';
  }
}

// --- reading A2A parts ---
//
// On the wire a Part is flat (`{"text": "…"}`); in the SDK it is a union keyed by
// `content.$case`. Only the SDK shape reaches this file.

const textOf = (parts: Part[]): string =>
  parts
    .map((p) => (p.content?.$case === 'text' ? p.content.value : ''))
    .filter(Boolean)
    .join('');

const dataOf = (parts: Part[]): unknown => {
  for (const part of parts) {
    if (part.content?.$case === 'data') return part.content.value;
  }
  return undefined;
};

const userMessage = (text: string, contextId: string): Message => ({
  messageId: crypto.randomUUID(),
  contextId,
  taskId: '',
  role: Role.ROLE_USER,
  parts: [{ content: { $case: 'text', value: text }, metadata: undefined, filename: '', mediaType: 'text/plain' }],
  metadata: {},
  extensions: [],
  referenceTaskIds: [],
});

export class A2APool {
  private readonly clients = new Map<string, Promise<Client>>();
  private readonly factory = new ClientFactory();

  constructor(private readonly opts: A2APoolOptions) {}

  aliases(): string[] {
    return Object.keys(this.opts.agents);
  }

  /** Resolves the alias a caller used, or the only agent when there is exactly one. */
  private urlFor(alias?: string): { alias: string; url: string } {
    const known = this.aliases();
    if (!alias) {
      if (known.length === 1) return { alias: known[0], url: this.opts.agents[known[0]] };
      throw new UnknownAgentError('(omitted)', known);
    }
    const url = this.opts.agents[alias];
    if (!url) throw new UnknownAgentError(alias, known);
    return { alias, url };
  }

  private client(alias: string, url: string): Promise<Client> {
    const existing = this.clients.get(alias);
    if (existing) return existing;
    const built = this.factory.createFromUrl(url);
    this.clients.set(alias, built);
    // A failed handshake must not be cached, or the agent stays broken until restart.
    built.catch(() => this.clients.delete(alias));
    return built;
  }

  /**
   * Runs one turn and blocks until the task reaches a state it will not leave on its own.
   *
   * `onUpdate` is called for every event the agent streams. That is what the heartbeat
   * feeds on, so it is deliberately not throttled here.
   */
  async ask(
    args: { agent?: string; text: string; contextId?: string },
    onUpdate: (update: AskUpdate) => void,
    signal?: AbortSignal,
  ): Promise<AskResult> {
    const { alias, url } = this.urlFor(args.agent);
    const client = await this.client(alias, url);

    const result: AskResult = {
      taskId: '',
      contextId: args.contextId ?? '',
      state: TaskState.TASK_STATE_UNSPECIFIED,
      answer: '',
      data: undefined,
      question: null,
    };

    const stream = client.sendMessageStream(
      {
        tenant: '',
        message: userMessage(args.text, args.contextId ?? ''),
        configuration: undefined,
        metadata: undefined,
      },
      { signal },
    );

    for await (const event of stream as AsyncGenerator<StreamResponse>) {
      const payload = event.payload;
      if (!payload) continue;

      if (payload.$case === 'task') {
        result.taskId = payload.value.id;
        result.contextId = payload.value.contextId;
        result.state = payload.value.status.state;
        onUpdate({ kind: 'task', state: result.state, text: 'task accepted' });
      } else if (payload.$case === 'statusUpdate') {
        const status = payload.value.status;
        result.taskId = payload.value.taskId || result.taskId;
        result.contextId = payload.value.contextId || result.contextId;
        result.state = status.state;
        const said = status.message ? textOf(status.message.parts) : '';
        if (status.state === TaskState.TASK_STATE_INPUT_REQUIRED) result.question = said;
        onUpdate({ kind: 'status', state: status.state, text: said || TaskState[status.state] });
      } else if (payload.$case === 'artifactUpdate') {
        const artifact = payload.value.artifact;
        result.answer += textOf(artifact.parts);
        const structured = dataOf(artifact.parts);
        if (structured !== undefined) result.data = structured;
        onUpdate({ kind: 'artifact', state: result.state, text: `artifact «${artifact.name}»` });
      } else if (payload.$case === 'message') {
        result.answer += textOf(payload.value.parts);
      }
    }

    this.opts.logs.call('a2a.ask', {
      agent: alias,
      taskId: result.taskId,
      contextId: result.contextId,
      state: TaskState[result.state],
      answerChars: result.answer.length,
    });
    return result;
  }

  async task(alias: string | undefined, taskId: string): Promise<Task> {
    const { alias: name, url } = this.urlFor(alias);
    const client = await this.client(name, url);
    return client.getTask({ tenant: '', id: taskId, historyLength: 0 });
  }

  async cancel(alias: string | undefined, taskId: string): Promise<Task> {
    const { alias: name, url } = this.urlFor(alias);
    const client = await this.client(name, url);
    this.opts.logs.call('a2a.cancel', { agent: name, taskId });
    return client.cancelTask({ tenant: '', id: taskId, metadata: undefined });
  }

  /**
   * Fetched directly rather than through the client, because the SDK keeps the card it
   * resolved to itself and a caller asking for the card wants what the agent publishes now.
   */
  async card(alias?: string): Promise<AgentCard> {
    const { url } = this.urlFor(alias);
    const target = new URL(AGENT_CARD_PATH, url.endsWith('/') ? url : `${url}/`);
    const response = await fetch(target, { headers: { 'A2A-Version': A2A_PROTOCOL_VERSION } });
    if (!response.ok) throw new Error(`agent card ${target}: HTTP ${response.status}`);
    return (await response.json()) as AgentCard;
  }
}
