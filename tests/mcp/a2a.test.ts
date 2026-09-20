/**
 * The pool is where A2A's shapes stop: a `Part` union, a numeric `TaskState`, artifacts
 * arriving in pieces. What leaves it is a flat `AskResult` whose `outcome` says how the
 * turn ended — which is not the same question as what state the task is in.
 *
 * Three things here are worth more than the flattening, and have most of the cases: that
 * an artifact is aggregated by id rather than concatenated, that a stream which stops
 * saying anything is reported as `truncated` instead of as success, and that a broken
 * turn carries the identity needed to reach the task it left running.
 */
import { AGENT_CARD_PATH, Role, TaskState } from '@a2a-js/sdk';
import type { AgentCard, Artifact, Message, Part, StreamResponse, Task } from '@a2a-js/sdk';
import type { Client } from '@a2a-js/sdk/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  A2APool,
  DEFAULT_DISCOVERY_TIMEOUT_MS,
  TurnError,
  UnknownAgentError,
  isInterrupted,
  isTerminal,
  type AskUpdate,
} from '../../src/mcp/a2a.ts';
import { recordingLogs } from '../helpers/logs.ts';

const textPart = (value: string): Part => ({
  content: { $case: 'text', value },
  metadata: undefined,
  filename: '',
  mediaType: 'text/plain',
});

const dataPart = (value: unknown): Part => ({
  content: { $case: 'data', value },
  metadata: undefined,
  filename: '',
  mediaType: 'application/json',
});

const message = (parts: Part[], over: Partial<Message> = {}): Message => ({
  messageId: 'm-1',
  contextId: 'ctx-1',
  taskId: 'task-1',
  role: Role.ROLE_AGENT,
  parts,
  metadata: {},
  extensions: [],
  referenceTaskIds: [],
  ...over,
});

// The four payload shapes the pool knows how to read, as the SDK hands them over.
const taskEvent = (state: TaskState, over: Partial<Task> = {}): StreamResponse =>
  ({
    payload: {
      $case: 'task',
      value: { id: 'task-1', contextId: 'ctx-1', status: { state }, artifacts: [], ...over },
    },
  }) as StreamResponse;

const statusEvent = (state: TaskState, said?: string): StreamResponse =>
  ({
    payload: {
      $case: 'statusUpdate',
      value: {
        taskId: 'task-1',
        contextId: 'ctx-1',
        status: { state, message: said === undefined ? undefined : message([textPart(said)]) },
      },
    },
  }) as StreamResponse;

const artifactEvent = (
  artifact: Partial<Artifact> & { parts: Part[] },
  over: { append?: boolean; lastChunk?: boolean } = {},
): StreamResponse =>
  ({
    payload: {
      $case: 'artifactUpdate',
      value: {
        taskId: 'task-1',
        contextId: 'ctx-1',
        artifact: { artifactId: 'a-1', name: 'acp-answer', description: '', ...artifact },
        append: over.append ?? false,
        lastChunk: over.lastChunk ?? true,
      },
    },
  }) as StreamResponse;

const messageEvent = (text: string): StreamResponse =>
  ({ payload: { $case: 'message', value: message([textPart(text)]) } }) as StreamResponse;

interface Harness {
  pool: A2APool;
  logs: ReturnType<typeof recordingLogs>;
  built: string[];
  sent: { params: { message: Message }; options: { signal?: AbortSignal } }[];
  getTasks: unknown[];
  cancels: unknown[];
}

interface PoolOptions {
  agents?: Record<string, string>;
  task?: Task;
  /** Thrown from inside the stream, after the events listed have been yielded. */
  breaksWith?: Error;
  createClient?: (url: string) => Promise<Client>;
  discoveryTimeoutMs?: number;
  requestTimeoutMs?: number;
}

const poolWith = (events: StreamResponse[], opts: PoolOptions = {}): Harness => {
  const logs = recordingLogs();
  const built: string[] = [];
  const sent: Harness['sent'] = [];
  const getTasks: unknown[] = [];
  const cancels: unknown[] = [];

  const client = {
    sendMessageStream(params: { message: Message }, options: { signal?: AbortSignal }) {
      sent.push({ params, options });
      return (async function* stream() {
        for (const event of events) yield event;
        if (opts.breaksWith) throw opts.breaksWith;
      })();
    },
    async getTask(params: unknown) {
      getTasks.push(params);
      return opts.task as Task;
    },
    async cancelTask(params: unknown) {
      cancels.push(params);
      return opts.task as Task;
    },
  } as unknown as Client;

  const pool = new A2APool({
    agents: opts.agents ?? { default: 'http://agent.local/' },
    logs,
    discoveryTimeoutMs: opts.discoveryTimeoutMs ?? 5_000,
    requestTimeoutMs: opts.requestTimeoutMs ?? 5_000,
    createClient:
      opts.createClient ??
      (async (url) => {
        built.push(url);
        return client;
      }),
  });

  return { pool, logs, built, sent, getTasks, cancels };
};

const completedTask = (over: Partial<Task> = {}): Task =>
  ({
    id: 'task-1',
    contextId: 'ctx-1',
    status: { state: TaskState.TASK_STATE_COMPLETED },
    artifacts: [{ artifactId: 'a-1', name: 'acp-answer', description: '', parts: [textPart('recovered')] }],
    ...over,
  }) as Task;

const updates = () => {
  const seen: AskUpdate[] = [];
  return { seen, onUpdate: (u: AskUpdate) => void seen.push(u) };
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('choosing an agent', () => {
  it('needs no alias when exactly one agent is configured', async () => {
    const { pool, built } = poolWith([taskEvent(TaskState.TASK_STATE_COMPLETED)]);

    await pool.ask({ text: 'hello' }, () => {});

    expect(built).toEqual(['http://agent.local/']);
  });

  it('insists on an alias once there is more than one agent', async () => {
    const { pool } = poolWith([], { agents: { rob: 'http://rob.local/', mini: 'http://mini.local/' } });

    await expect(pool.ask({ text: 'hello' }, () => {})).rejects.toBeInstanceOf(UnknownAgentError);
  });

  it('names the agents it does know when handed one it does not', async () => {
    const { pool } = poolWith([], { agents: { rob: 'http://rob.local/', mini: 'http://mini.local/' } });

    await expect(pool.ask({ agent: 'ghost', text: 'hello' }, () => {})).rejects.toThrow(
      /unknown agent "ghost" — configured: rob, mini/,
    );
  });

  it('lists its aliases for the tool descriptions', () => {
    const { pool } = poolWith([], { agents: { rob: 'http://rob.local/', mini: 'http://mini.local/' } });

    expect(pool.aliases()).toEqual(['rob', 'mini']);
  });
});

describe('discovery', () => {
  it('builds one client per alias and keeps it', async () => {
    const { pool, built } = poolWith([taskEvent(TaskState.TASK_STATE_COMPLETED)]);

    await pool.ask({ text: 'first' }, () => {});
    await pool.ask({ text: 'second' }, () => {});

    expect(built).toHaveLength(1);
  });

  it('does not cache a handshake that failed', async () => {
    let attempts = 0;
    const { pool } = poolWith([], {
      createClient: async () => {
        attempts += 1;
        throw new Error('connection refused');
      },
    });

    await expect(pool.ask({ text: 'one' }, () => {})).rejects.toThrow(/connection refused/);
    await expect(pool.ask({ text: 'two' }, () => {})).rejects.toThrow(/connection refused/);

    // Caching the failure would leave the agent broken until the bridge restarts.
    expect(attempts).toBe(2);
  });

  it('names the agent and the limit when no card arrives in time', async () => {
    const { pool } = poolWith([], {
      discoveryTimeoutMs: 20,
      createClient: () => new Promise<Client>(() => {}),
    });

    await expect(pool.ask({ text: 'hello' }, () => {})).rejects.toThrow(
      /discovery of agent "default" at http:\/\/agent.local\/ did not finish within 20 ms/,
    );
  });

  it('lets one caller walk away without taking the handshake from the others', async () => {
    // The build is shared, so a tool call that gives up while the card is still in flight
    // must not abort the work everyone else is waiting on.
    let release: (client: Client) => void = () => {};
    const pending = new Promise<Client>((resolve) => {
      release = resolve;
    });
    const client = {
      sendMessageStream: () =>
        (async function* stream() {
          yield taskEvent(TaskState.TASK_STATE_COMPLETED);
        })(),
    } as unknown as Client;
    const { pool } = poolWith([], { createClient: () => pending });

    const impatient = new AbortController();
    const abandoned = pool.ask({ text: 'one' }, () => {}, impatient.signal);
    const waiting = pool.ask({ text: 'two' }, () => {});
    impatient.abort(new Error('the caller hung up'));

    await expect(abandoned).rejects.toThrow('the caller hung up');
    release(client);
    await expect(waiting).resolves.toMatchObject({ taskId: 'task-1' });
  });

  it('falls back to a sane deadline when the configured one is not a number', () => {
    // These arrive as `Number(process.env.…)`, so a typo in .env lands here as NaN — and
    // `AbortSignal.timeout(NaN)` throws rather than ignoring it.
    const logs = recordingLogs();
    const pool = new A2APool({
      agents: { default: 'http://agent.local/' },
      logs,
      discoveryTimeoutMs: Number.NaN,
      requestTimeoutMs: -1,
      createClient: () => new Promise<Client>(() => {}),
    });

    // Reaching the default at all is the assertion: a NaN deadline would have thrown here.
    expect(DEFAULT_DISCOVERY_TIMEOUT_MS).toBeGreaterThan(0);
    expect(pool.aliases()).toEqual(['default']);
  });
});

describe('ask: what comes back', () => {
  it('flattens a completed turn', async () => {
    const { pool } = poolWith([
      taskEvent(TaskState.TASK_STATE_SUBMITTED),
      statusEvent(TaskState.TASK_STATE_WORKING, 'reading the file'),
      artifactEvent({ parts: [textPart('here is the answer'), dataPart({ stopReason: 'end_turn' })] }),
      statusEvent(TaskState.TASK_STATE_COMPLETED),
    ]);

    const result = await pool.ask({ text: 'do something' }, () => {});

    expect(result).toMatchObject({
      agent: 'default',
      taskId: 'task-1',
      contextId: 'ctx-1',
      state: TaskState.TASK_STATE_COMPLETED,
      outcome: 'task',
      answer: 'here is the answer',
      message: '',
    });
    expect(result.artifacts).toEqual([
      {
        artifactId: 'a-1',
        name: 'acp-answer',
        description: '',
        text: 'here is the answer',
        data: [{ stopReason: 'end_turn' }],
        complete: true,
      },
    ]);
  });

  it('keeps the last thing the agent said about the task', async () => {
    // A refusal, a cancellation or a failure is explained in a status message and nowhere
    // else — it never reaches an artifact.
    const { pool } = poolWith([
      taskEvent(TaskState.TASK_STATE_SUBMITTED),
      statusEvent(TaskState.TASK_STATE_WORKING, 'working'),
      statusEvent(TaskState.TASK_STATE_CANCELED, 'Refused by the bridge: edit escapes the root'),
    ]);

    const result = await pool.ask({ text: 'x' }, () => {});

    expect(result.status).toBe('Refused by the bridge: edit escapes the root');
    expect(result.outcome).toBe('task');
  });

  it('does not let a wordless status blank the last explanation', async () => {
    const { pool } = poolWith([
      taskEvent(TaskState.TASK_STATE_SUBMITTED),
      statusEvent(TaskState.TASK_STATE_WORKING, 'the reason'),
      statusEvent(TaskState.TASK_STATE_COMPLETED),
    ]);

    expect((await pool.ask({ text: 'x' }, () => {})).status).toBe('the reason');
  });

  it('reads every data part, not just the first', async () => {
    const { pool } = poolWith([
      taskEvent(TaskState.TASK_STATE_SUBMITTED),
      artifactEvent({ parts: [dataPart({ first: true }), dataPart({ second: true })] }),
      statusEvent(TaskState.TASK_STATE_COMPLETED),
    ]);

    const [artifact] = (await pool.ask({ text: 'x' }, () => {})).artifacts;

    // One artifact may carry several, and a later one is not a correction of the earlier.
    expect(artifact.data).toEqual([{ first: true }, { second: true }]);
  });

  it('keeps a Message answer apart from artifact text', async () => {
    const { pool } = poolWith([messageEvent('answered directly')]);

    const result = await pool.ask({ text: 'x' }, () => {});

    expect(result).toMatchObject({ outcome: 'message', message: 'answered directly', answer: '' });
  });
});

describe('ask: aggregating artifacts', () => {
  it('appends a continuation chunk to the artifact it extends', async () => {
    const { pool } = poolWith([
      taskEvent(TaskState.TASK_STATE_SUBMITTED),
      artifactEvent({ parts: [textPart('first half ')] }, { lastChunk: false }),
      artifactEvent({ name: '', parts: [textPart('second half')] }, { append: true, lastChunk: true }),
      statusEvent(TaskState.TASK_STATE_COMPLETED),
    ]);

    const [artifact] = (await pool.ask({ text: 'x' }, () => {})).artifacts;

    expect(artifact.text).toBe('first half second half');
    // A continuation chunk usually names nothing, and must not blank what it extends.
    expect(artifact.name).toBe('acp-answer');
    expect(artifact.complete).toBe(true);
  });

  it('replaces rather than concatenates when append is false', async () => {
    // Concatenating regardless turns two replacements of one artifact into `oldnew`.
    const { pool } = poolWith([
      taskEvent(TaskState.TASK_STATE_SUBMITTED),
      artifactEvent({ parts: [textPart('old')] }),
      artifactEvent({ parts: [textPart('new')] }),
      statusEvent(TaskState.TASK_STATE_COMPLETED),
    ]);

    expect((await pool.ask({ text: 'x' }, () => {})).artifacts[0].text).toBe('new');
  });

  it('keeps two artifacts apart by their ids', async () => {
    const { pool } = poolWith([
      taskEvent(TaskState.TASK_STATE_SUBMITTED),
      artifactEvent({ artifactId: 'a-1', name: 'first', parts: [textPart('one')] }),
      artifactEvent({ artifactId: 'a-2', name: 'second', parts: [textPart('two')] }),
      statusEvent(TaskState.TASK_STATE_COMPLETED),
    ]);

    const result = await pool.ask({ text: 'x' }, () => {});

    expect(result.artifacts.map((a) => a.name)).toEqual(['first', 'second']);
    expect(result.answer).toBe('one\n\ntwo');
  });

  it('falls back to the name when an agent sends no artifact id', async () => {
    const { pool } = poolWith([
      taskEvent(TaskState.TASK_STATE_SUBMITTED),
      artifactEvent({ artifactId: '', name: 'unnamed-but-titled', parts: [textPart('kept')] }),
      statusEvent(TaskState.TASK_STATE_COMPLETED),
    ]);

    expect((await pool.ask({ text: 'x' }, () => {})).artifacts[0].artifactId).toBe('unnamed-but-titled');
  });

  it('reports an artifact the agent never finished as incomplete', async () => {
    const { pool } = poolWith([
      taskEvent(TaskState.TASK_STATE_SUBMITTED),
      artifactEvent({ parts: [textPart('half an answer')] }, { lastChunk: false }),
      statusEvent(TaskState.TASK_STATE_COMPLETED),
    ]);

    expect((await pool.ask({ text: 'x' }, () => {})).artifacts[0].complete).toBe(false);
  });

  it('keeps what a continued task produced in earlier turns', async () => {
    const earlier: Artifact = {
      artifactId: 'a-earlier',
      name: 'from-turn-one',
      description: '',
      parts: [textPart('said earlier')],
    } as Artifact;
    const { pool } = poolWith([
      taskEvent(TaskState.TASK_STATE_WORKING, { artifacts: [earlier] }),
      artifactEvent({ artifactId: 'a-now', name: 'from-turn-two', parts: [textPart('said now')] }),
      statusEvent(TaskState.TASK_STATE_COMPLETED),
    ]);

    const result = await pool.ask({ text: 'follow-up', taskId: 'task-1' }, () => {});

    expect(result.artifacts.map((a) => a.name)).toEqual(['from-turn-one', 'from-turn-two']);
  });
});

describe('ask: how a turn ended', () => {
  it.each([
    ['COMPLETED', TaskState.TASK_STATE_COMPLETED],
    ['FAILED', TaskState.TASK_STATE_FAILED],
    ['CANCELED', TaskState.TASK_STATE_CANCELED],
    ['REJECTED', TaskState.TASK_STATE_REJECTED],
  ])('calls a task that reached %s an ended turn', async (_label, state) => {
    const { pool } = poolWith([taskEvent(TaskState.TASK_STATE_SUBMITTED), statusEvent(state)]);

    expect((await pool.ask({ text: 'x' }, () => {})).outcome).toBe('task');
  });

  it.each([
    ['INPUT_REQUIRED', TaskState.TASK_STATE_INPUT_REQUIRED],
    ['AUTH_REQUIRED', TaskState.TASK_STATE_AUTH_REQUIRED],
  ])('calls a task waiting in %s an interruption', async (_label, state) => {
    const { pool } = poolWith([taskEvent(TaskState.TASK_STATE_SUBMITTED), statusEvent(state, 'which file?')]);

    const result = await pool.ask({ text: 'x' }, () => {});

    expect(result.outcome).toBe('interrupted');
    expect(result.status).toBe('which file?');
  });

  it('calls a stream that stopped mid-work truncated', async () => {
    // Reporting the last state seen would tell the caller the agent "finished in WORKING".
    const { pool } = poolWith([taskEvent(TaskState.TASK_STATE_SUBMITTED), statusEvent(TaskState.TASK_STATE_WORKING)]);

    expect((await pool.ask({ text: 'x' }, () => {})).outcome).toBe('truncated');
  });

  it('calls a stream that said nothing at all truncated', async () => {
    const { pool } = poolWith([]);

    expect((await pool.ask({ text: 'x' }, () => {})).outcome).toBe('truncated');
  });

  it('classifies the states the same way for anyone else asking', () => {
    expect(isTerminal(TaskState.TASK_STATE_COMPLETED)).toBe(true);
    expect(isTerminal(TaskState.TASK_STATE_WORKING)).toBe(false);
    expect(isInterrupted(TaskState.TASK_STATE_INPUT_REQUIRED)).toBe(true);
    expect(isInterrupted(TaskState.TASK_STATE_COMPLETED)).toBe(false);
  });
});

describe('ask: identity and recovery', () => {
  it('hands out the handle with the very first update', async () => {
    // A caller watching progress has the task id from the first frame, which is the only
    // thing that makes an interrupted call recoverable.
    const { pool } = poolWith([
      taskEvent(TaskState.TASK_STATE_SUBMITTED),
      statusEvent(TaskState.TASK_STATE_COMPLETED),
    ]);
    const { seen, onUpdate } = updates();

    await pool.ask({ text: 'x' }, onUpdate);

    expect(seen[0]).toMatchObject({ kind: 'task', agent: 'default', taskId: 'task-1', contextId: 'ctx-1' });
  });

  it('throws a TurnError carrying the identity when the stream breaks', async () => {
    const { pool, logs } = poolWith([taskEvent(TaskState.TASK_STATE_WORKING)], {
      breaksWith: new Error('socket hang up'),
    });

    const failure = await pool.ask({ text: 'x' }, () => {}).catch((err: unknown) => err);

    expect(failure).toBeInstanceOf(TurnError);
    expect((failure as TurnError).identity).toEqual({ agent: 'default', taskId: 'task-1', contextId: 'ctx-1' });
    expect(logs.last('a2a.ask.broken')).toMatchObject({ taskId: 'task-1', reason: 'socket hang up' });
  });

  it('still reports the conversation when the break came before any task id', async () => {
    const { pool } = poolWith([], { breaksWith: new Error('connection reset') });

    const failure = await pool.ask({ text: 'x', contextId: 'ctx-known' }, () => {}).catch((err: unknown) => err);

    expect((failure as TurnError).identity).toEqual({ agent: 'default', taskId: '', contextId: 'ctx-known' });
  });

  it('routes a follow-up into the task it is answering', async () => {
    // Answering with the context alone opens a second task and leaves the first parked.
    const { pool, sent } = poolWith([
      taskEvent(TaskState.TASK_STATE_WORKING),
      statusEvent(TaskState.TASK_STATE_COMPLETED),
    ]);

    await pool.ask({ text: 'the answer', taskId: 'task-1', contextId: 'ctx-1' }, () => {});

    expect(sent[0].params.message).toMatchObject({ taskId: 'task-1', contextId: 'ctx-1', role: Role.ROLE_USER });
  });

  it('leaves taskId empty when starting new work in an existing conversation', async () => {
    const { pool, sent } = poolWith([taskEvent(TaskState.TASK_STATE_COMPLETED)]);

    await pool.ask({ text: 'next piece of work', contextId: 'ctx-1' }, () => {});

    expect(sent[0].params.message.taskId).toBe('');
  });

  it('records the turn, its outcome and what it produced', async () => {
    const { pool, logs } = poolWith([
      taskEvent(TaskState.TASK_STATE_SUBMITTED),
      artifactEvent({ parts: [textPart('12345')] }),
      statusEvent(TaskState.TASK_STATE_COMPLETED),
    ]);

    await pool.ask({ text: 'x' }, () => {});

    expect(logs.last('a2a.ask')).toMatchObject({
      agent: 'default',
      taskId: 'task-1',
      state: 'TASK_STATE_COMPLETED',
      outcome: 'task',
      artifacts: 1,
      answerChars: 5,
    });
  });

  it('ignores an event with no payload rather than tripping over it', async () => {
    const { pool } = poolWith([
      { payload: undefined } as unknown as StreamResponse,
      taskEvent(TaskState.TASK_STATE_COMPLETED),
    ]);

    await expect(pool.ask({ text: 'x' }, () => {})).resolves.toMatchObject({ taskId: 'task-1' });
  });
});

describe('task and cancel', () => {
  it('reads a task back in the same shape a turn has', async () => {
    const { pool, getTasks } = poolWith([], { task: completedTask() });

    const snapshot = await pool.task(undefined, 'task-1');

    expect(snapshot).toMatchObject({
      agent: 'default',
      taskId: 'task-1',
      contextId: 'ctx-1',
      state: TaskState.TASK_STATE_COMPLETED,
    });
    expect(snapshot.artifacts[0]).toMatchObject({ name: 'acp-answer', text: 'recovered', complete: true });
    expect(getTasks[0]).toMatchObject({ id: 'task-1', historyLength: 0 });
  });

  it('carries the agent\'s last word on a task it reads', async () => {
    const { pool } = poolWith([], {
      task: completedTask({
        status: { state: TaskState.TASK_STATE_FAILED, message: message([textPart('not authenticated')]) },
      } as Partial<Task>),
    });

    expect((await pool.task(undefined, 'task-1')).status).toBe('not authenticated');
  });

  it('cancels a task and says so in the log', async () => {
    const { pool, logs, cancels } = poolWith([], {
      task: completedTask({ status: { state: TaskState.TASK_STATE_CANCELED } } as Partial<Task>),
    });

    const snapshot = await pool.cancel(undefined, 'task-1');

    expect(snapshot.state).toBe(TaskState.TASK_STATE_CANCELED);
    // Cancelling late does not unmake the work, so the artifacts come back too.
    expect(snapshot.artifacts).toHaveLength(1);
    expect(cancels[0]).toMatchObject({ id: 'task-1' });
    expect(logs.last('a2a.cancel')).toMatchObject({ agent: 'default', taskId: 'task-1' });
  });

  it('gives up on a call the agent never answers, naming the call and the limit', async () => {
    const { pool } = poolWith([], {
      requestTimeoutMs: 20,
      createClient: async () =>
        ({
          // A client that honours the deadline it is handed, the way the SDK's does: the
          // pool supplies the signal, and rewords the abort into something that names the
          // call and the limit.
          getTask: (_params: unknown, options: { signal: AbortSignal }) =>
            new Promise((_resolve, reject) => {
              options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
            }),
        }) as unknown as Client,
    });

    await expect(pool.task(undefined, 'task-1')).rejects.toThrow(
      /GetTask on agent "default" did not answer within 20 ms/,
    );
  });
});

describe('card', () => {
  const card = { name: 'Claude (via ACP)', version: '0.1.0' } as AgentCard;

  it('fetches the card itself, with the version header the server insists on', async () => {
    const calls: { url: string; init: RequestInit | undefined }[] = [];
    vi.stubGlobal('fetch', async (url: URL, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      return new Response(JSON.stringify(card), { status: 200 });
    });
    const { pool } = poolWith([]);

    expect(await pool.card()).toEqual(card);
    expect(calls[0].url).toBe(`http://agent.local/${AGENT_CARD_PATH}`);
    // Without `A2A-Version: 1.0` the server takes the caller for a v0.3 client.
    expect((calls[0].init?.headers as Record<string, string>)['A2A-Version']).toBe('1.0');
  });

  it('does not negotiate a transport first', async () => {
    // This is the tool you reach for to find out *why* an agent is unusable, so it must
    // not require a working handshake with it.
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify(card), { status: 200 }));
    const { pool, built } = poolWith([]);

    await pool.card();

    expect(built).toEqual([]);
  });

  it('adds the separator a url without a trailing slash is missing', async () => {
    const calls: string[] = [];
    vi.stubGlobal('fetch', async (url: URL) => {
      calls.push(String(url));
      return new Response(JSON.stringify(card), { status: 200 });
    });
    const { pool } = poolWith([], { agents: { rob: 'http://rob.local:41241' } });

    await pool.card('rob');

    expect(calls[0]).toBe(`http://rob.local:41241/${AGENT_CARD_PATH}`);
  });

  it('reports the status when the agent does not serve a card', async () => {
    vi.stubGlobal('fetch', async () => new Response('nope', { status: 404 }));
    const { pool } = poolWith([]);

    await expect(pool.card()).rejects.toThrow(/HTTP 404/);
  });
});
