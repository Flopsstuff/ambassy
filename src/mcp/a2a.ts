/**
 * The A2A side of the bridge: one pool of clients, one method per tool.
 *
 * Clients are built lazily and kept, because `createFromUrl` fetches the agent card
 * and negotiates a transport on every call — work worth doing once per agent rather
 * than once per tool call. That build is *shared*, so it is bounded by a deadline of
 * its own and never cancelled by one caller: a tool call that gives up while the card
 * is still in flight must not take the handshake away from everyone else waiting on it.
 *
 * Everything the caller needs from a turn is flattened into `AskResult`. The tool
 * layer should not have to know that `Part` is a discriminated union in TypeScript
 * and a flat object on the wire, nor that `TaskState` is a numeric enum; those are
 * A2A's shapes, and they stop here. `task` and `cancel` return the same flattened
 * shape for the same reason.
 *
 * Every operation here settles: each has either a deadline or an abort signal, usually
 * both. An agent that accepts a connection and then says nothing is the failure this
 * bridge exists to report, not one it should wait out.
 */
import { AGENT_CARD_PATH, A2A_PROTOCOL_VERSION, Role, TaskState } from '@a2a-js/sdk';
import type { AgentCard, Artifact, Message, Part, StreamResponse, Task, TaskStatus } from '@a2a-js/sdk';
import { ClientFactory, ClientFactoryOptions, DefaultAgentCardResolver } from '@a2a-js/sdk/client';
import type { Client } from '@a2a-js/sdk/client';

import type { Logs } from '../acp/log.ts';

export interface A2APoolOptions {
  /** Agents by alias; the alias is what a tool caller names. */
  agents: Record<string, string>;
  logs: Logs;
  /** How long fetching an agent card and negotiating a transport may take. */
  discoveryTimeoutMs: number;
  /** How long a single request/response call (task, cancel, card) may take. */
  requestTimeoutMs: number;
}

/**
 * Where work already in flight can be picked up again.
 *
 * Carried by updates and by the errors thrown out of `ask`, because a turn that breaks
 * after the agent accepted the task leaves a task running on the other side — and the
 * caller cannot reach it without these three strings.
 */
export interface AskIdentity {
  agent: string;
  taskId: string;
  contextId: string;
}

/** One forwarded step of a turn, already reduced to something printable. */
export interface AskUpdate extends AskIdentity {
  kind: 'task' | 'status' | 'artifact' | 'message';
  state: TaskState | null;
  text: string;
}

/** One artifact, with its identity kept and its parts sorted into text and data. */
export interface FlatArtifact {
  artifactId: string;
  name: string;
  description: string;
  /** The text parts, in the order the agent sent them. */
  text: string;
  /** Every data part, in order — one artifact may carry several, and they are not interchangeable. */
  data: unknown[];
  /** False while the agent has not yet marked the artifact finished. */
  complete: boolean;
}

/**
 * How a turn ended, which is not the same question as what state the task is in.
 *
 * `task` and `message` are the two answers A2A defines; `interrupted` is a live task
 * waiting on the caller; `truncated` is a stream that stopped saying anything before
 * reaching any of the three, and is the one case a caller must not read as success.
 */
export type AskOutcome = 'task' | 'message' | 'interrupted' | 'truncated';

export interface AskResult extends AskIdentity {
  state: TaskState;
  outcome: AskOutcome;
  /** The artifacts of the turn, aggregated by id and kept apart. */
  artifacts: FlatArtifact[];
  /** Text of every artifact, in order — the convenient reading of `artifacts`. */
  answer: string;
  /** Text the agent sent as a Message rather than as an artifact. */
  message: string;
  /**
   * The last thing the agent said about the task's own state. Often the only
   * explanation there is of a refusal, a cancellation or a failure, because it travels
   * in a status message and never reaches an artifact.
   */
  status: string;
}

/** A task read back or cancelled, flattened the same way a turn is. */
export interface TaskSnapshot extends AskIdentity {
  state: TaskState;
  status: string;
  artifacts: FlatArtifact[];
}

export class UnknownAgentError extends Error {
  constructor(alias: string, known: string[]) {
    super(`unknown agent "${alias}" — configured: ${known.join(', ') || '(none)'}`);
    this.name = 'UnknownAgentError';
  }
}

/**
 * A turn that broke while it was running, carrying whatever identity was known by then.
 *
 * The identity is the point: without it an interrupted `a2a_ask` is a dead end, while the
 * task it started keeps running on the agent.
 */
export class TurnError extends Error {
  constructor(
    message: string,
    readonly identity: AskIdentity,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'TurnError';
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

/** Every data part, not the first one: an artifact may carry several, and later ones are not corrections. */
const dataOf = (parts: Part[]): unknown[] =>
  parts.filter((p) => p.content?.$case === 'data').map((p) => (p.content as { $case: 'data'; value: unknown }).value);

// `TaskStatus` is optional in the generated types — a proto message field always is. These two
// keep that fact in one place instead of spreading `?.` over every branch that reads a status.
const stateOf = (status: TaskStatus | undefined): TaskState => status?.state ?? TaskState.TASK_STATE_UNSPECIFIED;

const statusTextOf = (status: TaskStatus | undefined): string =>
  status?.message ? textOf(status.message.parts) : '';

const userMessage = (text: string, contextId: string, taskId: string): Message => ({
  messageId: crypto.randomUUID(),
  contextId,
  // Non-empty only when continuing: this is what routes the message into an existing task
  // instead of opening a new one in the same conversation.
  taskId,
  role: Role.ROLE_USER,
  parts: [{ content: { $case: 'text', value: text }, metadata: undefined, filename: '', mediaType: 'text/plain' }],
  metadata: {},
  extensions: [],
  referenceTaskIds: [],
});

// --- artifact aggregation ---
//
// An artifact arrives in pieces, keyed by `artifactId`, and `append` says whether a piece
// extends the last one or replaces it. Concatenating everything regardless turns two
// replacements of one artifact — `old` then `new` — into `oldnew`, and merges artifacts
// that were never the same artifact.

interface Accumulator {
  artifactId: string;
  name: string;
  description: string;
  parts: Part[];
  complete: boolean;
}

/**
 * `artifactId` is required by the spec and unique within a task, so it is the key.
 * The fallbacks are for an agent that omits it: a name keeps distinct artifacts apart,
 * and the last resort at least keeps the content.
 */
const keyOf = (artifact: Artifact): string => artifact.artifactId || artifact.name || '(unidentified artifact)';

const seed = (artifact: Artifact, complete: boolean): Accumulator => ({
  artifactId: keyOf(artifact),
  name: artifact.name,
  description: artifact.description,
  parts: [...artifact.parts],
  complete,
});

const flatten = (acc: Accumulator): FlatArtifact => ({
  artifactId: acc.artifactId,
  name: acc.name,
  description: acc.description,
  text: textOf(acc.parts),
  data: dataOf(acc.parts),
  complete: acc.complete,
});

/** The same flattening a turn gets, so a task read back is not a poorer answer than the turn was. */
const snapshotOf = (task: Task, alias: string): TaskSnapshot => ({
  agent: alias,
  taskId: task.id,
  contextId: task.contextId,
  state: stateOf(task.status),
  status: statusTextOf(task.status),
  artifacts: (task.artifacts ?? []).map((artifact) => flatten(seed(artifact, true))),
});

// --- states ---

const TERMINAL: ReadonlySet<TaskState> = new Set([
  TaskState.TASK_STATE_COMPLETED,
  TaskState.TASK_STATE_FAILED,
  TaskState.TASK_STATE_CANCELED,
  TaskState.TASK_STATE_REJECTED,
]);

/** Not terminal and not progress: the task is alive and waiting for the caller to do something. */
const INTERRUPTED: ReadonlySet<TaskState> = new Set([
  TaskState.TASK_STATE_INPUT_REQUIRED,
  TaskState.TASK_STATE_AUTH_REQUIRED,
]);

export const isTerminal = (state: TaskState): boolean => TERMINAL.has(state);
export const isInterrupted = (state: TaskState): boolean => INTERRUPTED.has(state);

// --- waiting, with a way out ---

const describe = (err: unknown): string => (err instanceof Error ? err.message : String(err));

const abortReason = (signal: AbortSignal): unknown =>
  signal.reason instanceof Error ? signal.reason : new Error(describe(signal.reason) || 'the call was aborted');

/**
 * Rejects when `signal` aborts, leaving `promise` alone.
 *
 * The difference from passing the signal downwards is the whole point: a shared agent
 * handshake belongs to every caller waiting on it, so one caller walking away from the
 * wait must not abort the work the others are still waiting for.
 */
const abortable = <T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> => {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(abortReason(signal));
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(abortReason(signal));
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
};

/** A deadline that settles the wait, and says what it was waiting for. */
const withDeadline = <T>(promise: Promise<T>, ms: number, what: string): Promise<T> => {
  if (!Number.isFinite(ms) || ms <= 0) return promise;
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${what} did not finish within ${ms} ms`)), ms);
    // A pending deadline is no reason for the bridge to stay up.
    timer.unref();
    promise.then(resolve, reject).finally(() => clearTimeout(timer));
  });
};

/**
 * A fetch that gives up. The card resolver is where discovery actually blocks, and a
 * deadline on the promise alone would leave the socket open behind it.
 */
const boundedFetch = (ms: number): typeof fetch => {
  return (input, init) => {
    const deadline = AbortSignal.timeout(ms);
    const signal = init?.signal ? AbortSignal.any([init.signal, deadline]) : deadline;
    return fetch(input, { ...init, signal });
  };
};

export class A2APool {
  private readonly clients = new Map<string, Promise<Client>>();
  private readonly factory: ClientFactory;

  constructor(private readonly opts: A2APoolOptions) {
    this.factory = new ClientFactory(
      ClientFactoryOptions.createFrom(ClientFactoryOptions.default, {
        cardResolver: new DefaultAgentCardResolver({ fetchImpl: boundedFetch(opts.discoveryTimeoutMs) }),
      }),
    );
  }

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

  /**
   * The shared handshake, bounded by `discoveryTimeoutMs` and awaited abortably.
   *
   * Two failure modes, deliberately separated. A server that accepts the connection and
   * never returns its card is *discovery's* problem, and the deadline ends it for everyone.
   * A caller that gives up meanwhile is that caller's problem alone, so its signal ends
   * only its own wait.
   */
  private discover(alias: string, url: string, signal?: AbortSignal): Promise<Client> {
    const existing = this.clients.get(alias);
    if (existing) return abortable(existing, signal);

    const what = `discovery of agent "${alias}" at ${url}`;
    const built = withDeadline(
      // The bounded fetch inside the card resolver usually wins the race against the
      // deadline below, and `TimeoutError: The operation was aborted` names neither the
      // agent nor the limit. Both paths therefore say the same thing.
      this.factory.createFromUrl(url).catch((err: unknown) => {
        const reason =
          (err as Error)?.name === 'TimeoutError'
            ? `no agent card within ${this.opts.discoveryTimeoutMs} ms`
            : describe(err);
        throw new Error(`${what} failed: ${reason}`, { cause: err });
      }),
      this.opts.discoveryTimeoutMs,
      what,
    );
    this.clients.set(alias, built);
    // A failed handshake must not be cached, or the agent stays broken until restart. The
    // identity check matters: by the time this runs, a retry may already have replaced it.
    built.catch(() => {
      if (this.clients.get(alias) === built) this.clients.delete(alias);
    });
    return abortable(built, signal);
  }

  /**
   * One request/response call, with a deadline of its own on top of the caller's signal.
   *
   * `ask` has the silence gate to notice an agent that stopped answering; these three had
   * nothing, which left the same hole open for the other three tools.
   */
  private async call<T>(
    what: string,
    alias: string | undefined,
    signal: AbortSignal | undefined,
    run: (client: Client, deadline: AbortSignal, target: { alias: string; url: string }) => Promise<T>,
  ): Promise<T> {
    const target = this.urlFor(alias);
    const client = await this.discover(target.alias, target.url, signal);
    return this.bounded(what, target.alias, signal, (deadline) => run(client, deadline, target));
  }

  /** The deadline half of `call`, for the one operation that must not need a client first. */
  private async bounded<T>(
    what: string,
    alias: string,
    signal: AbortSignal | undefined,
    run: (deadline: AbortSignal) => Promise<T>,
  ): Promise<T> {
    const timeout = AbortSignal.timeout(this.opts.requestTimeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    try {
      return await run(combined);
    } catch (err) {
      // The caller's own abort keeps its reason; only our deadline is reworded, because
      // `TimeoutError: The operation was aborted` names neither the call nor the limit.
      if (timeout.aborted && !signal?.aborted) {
        throw new Error(`${what} on agent "${alias}" did not answer within ${this.opts.requestTimeoutMs} ms`, {
          cause: err,
        });
      }
      throw err;
    }
  }

  /**
   * Runs one turn and blocks until the task reaches a state it will not leave on its own.
   *
   * With `taskId` the message continues that task; without it a new task opens, in the
   * given `contextId` when there is one. Both matter: continuing is how an `INPUT_REQUIRED`
   * question gets answered, and starting fresh in the same context is how a conversation
   * moves on to the next piece of work.
   *
   * `onUpdate` is called for every event the agent streams. That is what the heartbeat
   * feeds on, so it is deliberately not throttled here.
   */
  async ask(
    args: { agent?: string; text: string; contextId?: string; taskId?: string },
    onUpdate: (update: AskUpdate) => void,
    signal?: AbortSignal,
  ): Promise<AskResult> {
    const { alias, url } = this.urlFor(args.agent);
    const client = await this.discover(alias, url, signal);

    const identity: AskIdentity = {
      agent: alias,
      taskId: args.taskId ?? '',
      contextId: args.contextId ?? '',
    };
    let state = TaskState.TASK_STATE_UNSPECIFIED;
    let status = '';
    let message = '';
    let sawTask = false;
    let sawMessage = false;
    const artifacts = new Map<string, Accumulator>();

    const report = (kind: AskUpdate['kind'], text: string): void =>
      onUpdate({ kind, state, text, ...identity });

    const stream = client.sendMessageStream(
      {
        tenant: '',
        message: userMessage(args.text, identity.contextId, identity.taskId),
        configuration: undefined,
        metadata: undefined,
      },
      { signal },
    );

    try {
      for await (const event of stream as AsyncGenerator<StreamResponse>) {
        const payload = event.payload;
        if (!payload) continue;

        if (payload.$case === 'task') {
          const task = payload.value;
          sawTask = true;
          identity.taskId = task.id || identity.taskId;
          identity.contextId = task.contextId || identity.contextId;
          state = stateOf(task.status);
          const said = statusTextOf(task.status);
          if (said) status = said;
          // A continued task arrives carrying what it produced before this turn. Dropping
          // that would lose the earlier answer of a conversation the caller is still in.
          for (const artifact of task.artifacts ?? []) {
            const key = keyOf(artifact);
            if (!artifacts.has(key)) artifacts.set(key, seed(artifact, true));
          }
          // The identity goes out with the first update on purpose: a caller watching
          // progress has a handle from the first frame, which is the only thing that makes
          // an interrupted call recoverable.
          report('task', `task ${identity.taskId} accepted in context ${identity.contextId}`);
        } else if (payload.$case === 'statusUpdate') {
          identity.taskId = payload.value.taskId || identity.taskId;
          identity.contextId = payload.value.contextId || identity.contextId;
          state = stateOf(payload.value.status);
          const said = statusTextOf(payload.value.status);
          if (said) status = said;
          report('status', said || TaskState[state]);
        } else if (payload.$case === 'artifactUpdate') {
          const update = payload.value;
          identity.taskId = update.taskId || identity.taskId;
          identity.contextId = update.contextId || identity.contextId;
          const artifact = update.artifact;
          if (!artifact) continue;
          const key = keyOf(artifact);
          const existing = artifacts.get(key);
          if (existing && update.append) {
            existing.parts.push(...artifact.parts);
            // A continuation chunk usually names nothing; it must not blank what it extends.
            if (!existing.name && artifact.name) existing.name = artifact.name;
            if (!existing.description && artifact.description) existing.description = artifact.description;
            existing.complete = update.lastChunk;
          } else {
            artifacts.set(key, seed(artifact, update.lastChunk));
          }
          report('artifact', `artifact «${artifact.name || key}»`);
        } else if (payload.$case === 'message') {
          const direct = payload.value;
          sawMessage = true;
          identity.taskId = direct.taskId || identity.taskId;
          identity.contextId = direct.contextId || identity.contextId;
          message += textOf(direct.parts);
          report('message', 'message');
        }
      }
    } catch (err) {
      // Identity travels with the failure. The task on the other side is unaffected by this
      // stream breaking, so the caller is owed the handle rather than just the reason.
      this.opts.logs.call('a2a.ask.broken', { ...identity, reason: describe(err) });
      throw new TurnError(describe(err), { ...identity }, { cause: err });
    }

    // A stream is allowed to end in exactly three ways. Anything else — and in particular a
    // task left in WORKING, or a stream that said nothing at all — is a turn that lost its
    // ending, which must not be rendered as an agent that finished.
    const outcome: AskOutcome = sawTask
      ? isTerminal(state)
        ? 'task'
        : isInterrupted(state)
          ? 'interrupted'
          : 'truncated'
      : sawMessage
        ? 'message'
        : 'truncated';

    const flat = [...artifacts.values()].map(flatten);
    const result: AskResult = {
      ...identity,
      state,
      outcome,
      artifacts: flat,
      answer: flat
        .map((a) => a.text)
        .filter(Boolean)
        .join('\n\n'),
      message,
      status,
    };

    this.opts.logs.call('a2a.ask', {
      agent: alias,
      taskId: result.taskId,
      contextId: result.contextId,
      state: TaskState[result.state],
      outcome,
      artifacts: flat.length,
      answerChars: result.answer.length,
    });
    return result;
  }

  async task(alias: string | undefined, taskId: string, signal?: AbortSignal): Promise<TaskSnapshot> {
    return this.call('GetTask', alias, signal, async (client, deadline, target) => {
      const task = await client.getTask({ tenant: '', id: taskId, historyLength: 0 }, { signal: deadline });
      return snapshotOf(task, target.alias);
    });
  }

  async cancel(alias: string | undefined, taskId: string, signal?: AbortSignal): Promise<TaskSnapshot> {
    return this.call('CancelTask', alias, signal, async (client, deadline, target) => {
      this.opts.logs.call('a2a.cancel', { agent: target.alias, taskId });
      const task = await client.cancelTask({ tenant: '', id: taskId, metadata: undefined }, { signal: deadline });
      return snapshotOf(task, target.alias);
    });
  }

  /**
   * Fetched directly rather than through the client, because the SDK keeps the card it
   * resolved to itself and a caller asking for the card wants what the agent publishes now.
   *
   * Deliberately skips discovery as well: this is the tool you reach for to find out *why*
   * an agent is unusable, so it must not first require negotiating a transport with it.
   */
  async card(alias?: string, signal?: AbortSignal): Promise<AgentCard> {
    const { alias: name, url } = this.urlFor(alias);
    return this.bounded('the agent card', name, signal, async (deadline) => {
      const cardUrl = new URL(AGENT_CARD_PATH, url.endsWith('/') ? url : `${url}/`);
      const response = await fetch(cardUrl, {
        headers: { 'A2A-Version': A2A_PROTOCOL_VERSION },
        signal: deadline,
      });
      if (!response.ok) throw new Error(`agent card ${cardUrl}: HTTP ${response.status}`);
      return (await response.json()) as AgentCard;
    });
  }
}
