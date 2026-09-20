/**
 * What a calling agent actually sees: four tools, and the text they answer with.
 *
 * The tools are exercised through the handlers they register rather than over HTTP — the
 * transport is the SDK's business, while the rendering is this repository's. Most of
 * these cases are about the answers that are not a plain success: an interruption that
 * has to name the task it is continuing, a stream that lost its ending, and a call that
 * broke while work carried on running on the agent.
 */
import { TaskState } from '@a2a-js/sdk';
import type { CallToolResult, McpServer, ServerContext } from '@modelcontextprotocol/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { z } from 'zod';
import {
  TurnError,
  UnknownAgentError,
  type A2APool,
  type AskResult,
  type AskUpdate,
  type FlatArtifact,
  type TaskSnapshot,
} from '../../src/mcp/a2a.ts';
import { registerTools } from '../../src/mcp/tools.ts';
import { recordingLogs, type RecordingLogs } from '../helpers/logs.ts';

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

type Handler = (args: Record<string, unknown>, ctx: ServerContext) => Promise<CallToolResult>;

interface Registered {
  config: { title?: string; description?: string; inputSchema?: unknown };
  handler: Handler;
}

const artifact = (over: Partial<FlatArtifact> = {}): FlatArtifact => ({
  artifactId: 'a-1',
  name: 'acp-answer',
  description: '',
  text: 'here is the answer',
  data: [],
  complete: true,
  ...over,
});

const answer = (over: Partial<AskResult> = {}): AskResult => ({
  agent: 'default',
  taskId: 'task-1',
  contextId: 'ctx-1',
  state: TaskState.TASK_STATE_COMPLETED,
  outcome: 'task',
  artifacts: [artifact()],
  answer: 'here is the answer',
  message: '',
  status: '',
  ...over,
});

const snapshot = (over: Partial<TaskSnapshot> = {}): TaskSnapshot => ({
  agent: 'default',
  taskId: 'task-1',
  contextId: 'ctx-1',
  state: TaskState.TASK_STATE_COMPLETED,
  status: '',
  artifacts: [artifact({ text: 'recovered answer' })],
  ...over,
});

interface CallOptions {
  progressToken?: string | number;
  /** The caller's own signal, for the case where it hangs up mid-call. */
  signal?: AbortSignal;
}

interface Harness {
  tools: Map<string, Registered>;
  logs: RecordingLogs;
  notifications: { progressToken: string | number; progress: number; message: string }[];
  call(name: string, args?: Record<string, unknown>, opts?: CallOptions): Promise<CallToolResult>;
}

const harness = (pool: Partial<A2APool>, opts: { heartbeatMs?: number; silenceLimitMs?: number } = {}): Harness => {
  const tools = new Map<string, Registered>();
  const logs = recordingLogs();
  const notifications: Harness['notifications'] = [];
  const server = {
    registerTool: (name: string, config: Registered['config'], handler: Handler) =>
      void tools.set(name, { config, handler }),
  } as unknown as McpServer;

  registerTools(server, {
    pool: { aliases: () => ['default'], ...pool } as A2APool,
    logs,
    heartbeatMs: opts.heartbeatMs ?? 60_000,
    silenceLimitMs: opts.silenceLimitMs ?? 600_000,
  });

  return {
    tools,
    logs,
    notifications,
    call: (name, args = {}, { progressToken, signal } = {}) => {
      const ctx = {
        mcpReq: {
          _meta: progressToken === undefined ? undefined : { progressToken },
          signal,
          notify: async (notification: { params: Harness['notifications'][number] }) => {
            notifications.push(notification.params);
          },
        },
      } as unknown as ServerContext;
      const tool = tools.get(name);
      if (!tool) throw new Error(`no such tool: ${name}`);
      return tool.handler(args, ctx);
    },
  };
};

const textOf = (result: CallToolResult): string =>
  result.content.map((block) => (block.type === 'text' ? block.text : '')).join('\n');

const envelopeOf = (result: CallToolResult): Record<string, unknown> => {
  const block = result.content.at(-1);
  const raw = block && block.type === 'text' ? block.text : '';
  return JSON.parse(raw.replace(/^```json\n/, '').replace(/\n```$/, '')) as Record<string, unknown>;
};

describe('registration', () => {
  it('publishes exactly the four tools the bridge promises', () => {
    const { tools } = harness({});

    expect([...tools.keys()]).toEqual(['a2a_ask', 'a2a_task', 'a2a_cancel', 'a2a_card']);
  });

  it('names the configured agents where a caller will read it', () => {
    // No skills[] projection: the card declares one generic skill, so there is one
    // generic tool, and the alias is the only thing to choose between agents.
    const { tools } = harness({ aliases: () => ['rob', 'mini'] });

    const schema = tools.get('a2a_ask')?.config.inputSchema as z.ZodObject<{ agent: z.ZodTypeAny }>;
    expect(schema.shape.agent.description).toContain('rob, mini');
  });

  it('offers taskId as well as contextId, since they continue different things', () => {
    const { tools } = harness({});
    const schema = tools.get('a2a_ask')?.config.inputSchema as z.ZodObject<{
      taskId: z.ZodTypeAny;
      contextId: z.ZodTypeAny;
    }>;

    expect(schema.shape.taskId.description).toContain('input-required');
    expect(schema.shape.contextId.description).toContain('conversation');
  });
});

describe('a2a_ask: a turn that ended', () => {
  it('answers with the text first and the envelope second', async () => {
    const { call } = harness({ ask: async () => answer() });

    const result = await call('a2a_ask', { text: 'do something' });

    expect(result.isError).toBeUndefined();
    expect(textOf(result)).toContain('here is the answer');
    expect(envelopeOf(result)).toMatchObject({
      agent: 'default',
      taskId: 'task-1',
      contextId: 'ctx-1',
      state: 'TASK_STATE_COMPLETED',
      outcome: 'task',
    });
  });

  it('keeps the artifacts apart in the envelope, data included', async () => {
    // Deliberately not an outputSchema: that payload is the downstream bridge's envelope,
    // and freezing its shape here would break the moment it grows a field.
    const { call } = harness({
      ask: async () =>
        answer({
          artifacts: [
            artifact({ artifactId: 'a-1', name: 'acp-answer', data: [{ stopReason: 'end_turn' }] }),
            artifact({ artifactId: 'a-2', name: 'notes', text: 'a second artifact', data: [] }),
          ],
        }),
    });

    expect(envelopeOf(await call('a2a_ask', { text: 'x' })).artifacts).toEqual([
      { artifactId: 'a-1', name: 'acp-answer', text: 'here is the answer', data: [{ stopReason: 'end_turn' }] },
      { artifactId: 'a-2', name: 'notes', text: 'a second artifact' },
    ]);
  });

  it('flags an artifact the agent never finished', async () => {
    const { call } = harness({ ask: async () => answer({ artifacts: [artifact({ complete: false })] }) });

    expect(envelopeOf(await call('a2a_ask', { text: 'x' })).artifacts).toEqual([
      { artifactId: 'a-1', name: 'acp-answer', text: 'here is the answer', complete: false },
    ]);
  });

  it('says so when a turn ended without producing anything, and quotes the last status', async () => {
    const { call } = harness({
      ask: async () => answer({ artifacts: [], answer: '', status: 'Done, but 1 tool call(s) failed.' }),
    });

    const result = await call('a2a_ask', { text: 'x' });

    expect(textOf(result)).toContain('The agent finished in TASK_STATE_COMPLETED without producing an answer.');
    expect(textOf(result)).toContain('Its last status message: Done, but 1 tool call(s) failed.');
    expect(result.isError).toBeUndefined();
  });

  it.each([
    ['FAILED', TaskState.TASK_STATE_FAILED, 'The task failed'],
    ['REJECTED', TaskState.TASK_STATE_REJECTED, 'The task rejected'],
  ])('reports a task that ended %s as an error, with the reason', async (_label, state, lead) => {
    // The reason arrives in the last status message and nowhere else — the ACP bridge's
    // permission refusals come through exactly this way.
    const { call } = harness({
      ask: async () =>
        answer({ state, artifacts: [], answer: '', status: 'Claude is not authenticated' }),
    });

    const result = await call('a2a_ask', { text: 'x' });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain(`${lead}: Claude is not authenticated`);
  });

  it('keeps what a cancelled task produced anyway', async () => {
    const { call } = harness({
      ask: async () =>
        answer({
          state: TaskState.TASK_STATE_CANCELED,
          status: 'Cancelled. The agent had already finished this turn.',
        }),
    });

    const result = await call('a2a_ask', { text: 'x' });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('The task was cancelled');
    expect(textOf(result)).toContain('What it produced anyway:\n\nhere is the answer');
  });

  it('admits when a failure came with no explanation at all', async () => {
    const { call } = harness({
      ask: async () => answer({ state: TaskState.TASK_STATE_FAILED, artifacts: [], answer: '' }),
    });

    expect(textOf(await call('a2a_ask', { text: 'x' }))).toContain('(the agent gave no reason)');
  });

  it('renders a direct Message answer without recovery advice', async () => {
    // A Message is a complete answer in A2A: no task is created, so there is nothing to
    // recover and nothing to continue but the conversation.
    const { call } = harness({
      ask: async () =>
        answer({ outcome: 'message', artifacts: [], answer: '', message: 'answered directly', taskId: '' }),
    });

    const result = await call('a2a_ask', { text: 'x' });

    expect(result.isError).toBeUndefined();
    expect(textOf(result)).toContain('answered directly');
    expect(textOf(result)).not.toContain('a2a_task');
  });
});

describe('a2a_ask: a turn that did not end', () => {
  it('tells the caller how to answer an input-required question', async () => {
    // Answering with the context alone opens a *second* task and leaves this one parked,
    // so the instruction has to name the task.
    const { call } = harness({
      ask: async () =>
        answer({
          state: TaskState.TASK_STATE_INPUT_REQUIRED,
          outcome: 'interrupted',
          artifacts: [],
          answer: '',
          status: 'Which file did you mean?',
        }),
    });

    const result = await call('a2a_ask', { text: 'edit the file' });

    expect(result.isError).toBeUndefined();
    expect(textOf(result)).toContain('The agent needs more input before it can finish.');
    expect(textOf(result)).toContain('Which file did you mean?');
    expect(textOf(result)).toContain('"taskId": "task-1"');
    expect(textOf(result)).toContain('"contextId": "ctx-1"');
    expect(envelopeOf(result)).toMatchObject({ outcome: 'interrupted' });
  });

  it('names authentication when that is what the task is waiting for', async () => {
    const { call } = harness({
      ask: async () =>
        answer({
          state: TaskState.TASK_STATE_AUTH_REQUIRED,
          outcome: 'interrupted',
          artifacts: [],
          answer: '',
          status: 'log in first',
        }),
    });

    expect(textOf(await call('a2a_ask', { text: 'x' }))).toContain('The agent needs authentication');
  });

  it('writes the alias into the call it suggests, when there is one to write', async () => {
    const { call } = harness({
      aliases: () => ['rob', 'mini'],
      ask: async () =>
        answer({
          agent: 'rob',
          state: TaskState.TASK_STATE_INPUT_REQUIRED,
          outcome: 'interrupted',
          artifacts: [],
          answer: '',
        }),
    });

    // With two agents configured, a suggested call that omits the alias comes back
    // "unknown agent (omitted)".
    expect(textOf(await call('a2a_ask', { text: 'x', agent: 'rob' }))).toContain('"agent": "rob"');
  });

  it('refuses to render a truncated stream as success', async () => {
    const { call } = harness({
      ask: async () =>
        answer({
          state: TaskState.TASK_STATE_WORKING,
          outcome: 'truncated',
          artifacts: [],
          answer: '',
        }),
    });

    const result = await call('a2a_ask', { text: 'x' });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("The agent's stream ended while the task was TASK_STATE_WORKING");
    expect(textOf(result)).toContain('a2a_task { "taskId": "task-1"');
  });

  it('keeps whatever had arrived before the stream stopped', async () => {
    const { call } = harness({
      ask: async () => answer({ state: TaskState.TASK_STATE_WORKING, outcome: 'truncated' }),
    });

    expect(textOf(await call('a2a_ask', { text: 'x' }))).toContain(
      'What had arrived before it stopped:\n\nhere is the answer',
    );
  });

  it('warns about repeating work when no task id ever came back', async () => {
    // The agent creates the task before it streams the first frame, so a connection that
    // breaks in between leaves work running that this side never learned the name of.
    const { call } = harness({
      ask: async () =>
        answer({
          taskId: '',
          contextId: '',
          state: TaskState.TASK_STATE_UNSPECIFIED,
          outcome: 'truncated',
          artifacts: [],
          answer: '',
        }),
    });

    const result = await call('a2a_ask', { text: 'x' });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('before it said what it had accepted');
    expect(textOf(result)).toContain('whether the agent accepted this work is unknown');
    expect(textOf(result)).toContain('Retrying may run it a second time');
  });
});

describe('a2a_ask: when the call itself breaks', () => {
  it('hands an unknown alias back as the caller mistake it is', async () => {
    const { call } = harness({
      ask: async () => {
        throw new UnknownAgentError('ghost', ['rob']);
      },
    });

    const result = await call('a2a_ask', { text: 'x', agent: 'ghost' });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe('unknown agent "ghost" — configured: rob');
  });

  it('turns a broken stream into a failure that still carries the handle', async () => {
    const { call } = harness({
      ask: async () => {
        throw new TurnError('socket hang up', { agent: 'default', taskId: 'task-1', contextId: 'ctx-1' });
      },
    });

    const result = await call('a2a_ask', { text: 'x' });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('A2A call failed: socket hang up');
    expect(textOf(result)).toContain('The task is still on the agent and unaffected by this call ending');
    expect(envelopeOf(result)).toEqual({ agent: 'default', taskId: 'task-1', contextId: 'ctx-1' });
  });

  it('prefers the identity the failure carried over the one the caller supplied', async () => {
    const { call } = harness({
      ask: async () => {
        throw new TurnError('reset', { agent: 'default', taskId: 'task-from-stream', contextId: 'ctx-1' });
      },
    });

    expect(envelopeOf(await call('a2a_ask', { text: 'x', contextId: 'ctx-1' }))).toMatchObject({
      taskId: 'task-from-stream',
    });
  });

  it('adds no envelope when there is no task id to put in one', async () => {
    // An envelope of empty strings would only look like a handle.
    const { call } = harness({
      ask: async () => {
        throw new TurnError('connection refused', { agent: 'default', taskId: '', contextId: '' });
      },
    });

    const result = await call('a2a_ask', { text: 'x' });

    expect(result.content).toHaveLength(1);
    expect(textOf(result)).toContain('whether the agent accepted this work is unknown');
  });

  it('logs the handle when the caller hung up and will never read it', async () => {
    const hangUp = new AbortController();
    const { call, logs } = harness({
      ask: async () => {
        hangUp.abort(new Error('the client disconnected'));
        throw new TurnError('aborted', { agent: 'default', taskId: 'task-1', contextId: 'ctx-1' });
      },
    });

    await call('a2a_ask', { text: 'x' }, { signal: hangUp.signal });

    expect(logs.last('mcp.ask.abandoned')).toMatchObject({ taskId: 'task-1', reason: 'the caller disconnected' });
  });

  it('records what a call was continuing', async () => {
    const { call, logs } = harness({ ask: async () => answer() });

    await call('a2a_ask', { text: 'x', taskId: 'task-1', contextId: 'ctx-1' }, { progressToken: 'p-1' });

    expect(logs.last('mcp.ask')).toMatchObject({ hasProgressToken: true, taskId: 'task-1', contextId: 'ctx-1' });
  });
});

describe('a2a_ask: progress and the silence gate', () => {
  it('sends progress notifications only when the caller offered a token', async () => {
    const ask = async (_args: unknown, onUpdate: (u: AskUpdate) => void) => {
      onUpdate({
        kind: 'status',
        state: TaskState.TASK_STATE_WORKING,
        text: 'reading the file',
        agent: 'default',
        taskId: 'task-1',
        contextId: 'ctx-1',
      });
      return answer();
    };

    const withToken = harness({ ask });
    await withToken.call('a2a_ask', { text: 'x' }, { progressToken: 'p-1' });
    expect(withToken.notifications).toEqual([{ progressToken: 'p-1', progress: 1, message: 'reading the file' }]);

    const without = harness({ ask });
    await without.call('a2a_ask', { text: 'x' });
    expect(without.notifications).toEqual([]);
    expect(without.logs.last('mcp.ask')).toMatchObject({ hasProgressToken: false });
  });

  it('survives a notification the client refuses to accept', async () => {
    const { tools } = harness({
      ask: async (_args: unknown, onUpdate: (u: AskUpdate) => void) => {
        onUpdate({
          kind: 'status',
          state: TaskState.TASK_STATE_WORKING,
          text: 'working',
          agent: 'default',
          taskId: 'task-1',
          contextId: 'ctx-1',
        });
        return answer();
      },
    });
    const ctx = {
      mcpReq: {
        _meta: { progressToken: 'p-1' },
        signal: undefined,
        notify: async () => {
          throw new Error('client went away');
        },
      },
    } as unknown as ServerContext;

    // Fire-and-forget: a failed notification must not fail the turn.
    const result = await tools.get('a2a_ask')!.handler({ text: 'x' }, ctx);
    expect(result.isError).toBeUndefined();
  });

  describe('with a clock we control', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('aborts the turn, reports the silence, and still says how to recover', async () => {
      // Recording the verdict and awaiting the stream anyway would let a wedged agent hold
      // the call exactly as long as doing nothing would have.
      let aborted = false;
      const { call } = harness(
        {
          ask: (_args: unknown, onUpdate: (u: AskUpdate) => void, signal?: AbortSignal) =>
            new Promise<AskResult>((_resolve, reject) => {
              onUpdate({
                kind: 'task',
                state: TaskState.TASK_STATE_SUBMITTED,
                text: 'task accepted',
                agent: 'default',
                taskId: 'task-1',
                contextId: 'ctx-1',
              });
              signal?.addEventListener('abort', () => {
                aborted = true;
                reject(new Error('The operation was aborted'));
              });
            }),
        },
        { heartbeatMs: 1_000, silenceLimitMs: 5_000 },
      );

      const pending = call('a2a_ask', { text: 'x' }, { progressToken: 'p-1' });
      await vi.advanceTimersByTimeAsync(6_000);
      const result = await pending;

      expect(aborted).toBe(true);
      expect(result.isError).toBe(true);
      expect(textOf(result)).toMatch(/sent nothing for \d+s — giving up/);
      // The handle came from the first frame, and it is what makes this recoverable.
      expect(textOf(result)).toContain('a2a_task { "taskId": "task-1"');
      expect(envelopeOf(result)).toMatchObject({ taskId: 'task-1' });
    });

    it('keeps ticking while the upstream is alive, and never fires the gate', async () => {
      const { call, notifications } = harness(
        {
          ask: async (_args: unknown, onUpdate: (u: AskUpdate) => void) => {
            for (let i = 0; i < 6; i += 1) {
              onUpdate({
                kind: 'status',
                state: TaskState.TASK_STATE_WORKING,
                text: `step ${i}`,
                agent: 'default',
                taskId: 'task-1',
                contextId: 'ctx-1',
              });
              await vi.advanceTimersByTimeAsync(1_000);
            }
            return answer();
          },
        },
        { heartbeatMs: 1_000, silenceLimitMs: 5_000 },
      );

      const result = await call('a2a_ask', { text: 'x' }, { progressToken: 'p-1' });

      expect(result.isError).toBeUndefined();
      const progress = notifications.map((n) => n.progress);
      expect(progress.length).toBeGreaterThanOrEqual(6);
      expect(progress).toEqual([...progress].sort((a, b) => a - b));
    });
  });
});

describe('a2a_task', () => {
  it('recovers a finished task, artifacts and all', async () => {
    const { call } = harness({ task: async () => snapshot() });

    const result = await call('a2a_task', { taskId: 'task-1' });

    expect(textOf(result)).toContain('Task task-1 is TASK_STATE_COMPLETED in context ctx-1, with 1 artifact(s).');
    expect(textOf(result)).toContain('recovered answer');
    expect(envelopeOf(result)).toMatchObject({
      taskId: 'task-1',
      contextId: 'ctx-1',
      state: 'TASK_STATE_COMPLETED',
      artifacts: [{ artifactId: 'a-1', name: 'acp-answer', text: 'recovered answer' }],
    });
  });

  it('quotes the agent\'s last word on a task that failed', async () => {
    const { call } = harness({
      task: async () =>
        snapshot({ state: TaskState.TASK_STATE_FAILED, artifacts: [], status: 'Codex is not authenticated' }),
    });

    expect(textOf(await call('a2a_task', { taskId: 'task-1' }))).toContain(
      "Agent's last word: Codex is not authenticated",
    );
  });

  it('says how to continue a task that is still waiting', async () => {
    const { call } = harness({
      task: async () => snapshot({ state: TaskState.TASK_STATE_INPUT_REQUIRED, status: 'which file?' }),
    });

    expect(textOf(await call('a2a_task', { taskId: 'task-1' }))).toContain(
      'It is still open — continue it with a2a_ask { "taskId": "task-1", "contextId": "ctx-1", ' +
        '"agent": "default", "text": "…" }',
    );
  });

  it('copes with a task that has no artifacts yet', async () => {
    const { call } = harness({
      task: async () => snapshot({ state: TaskState.TASK_STATE_WORKING, artifacts: [] }),
    });

    expect(textOf(await call('a2a_task', { taskId: 'task-1' }))).toContain('TASK_STATE_WORKING in context ctx-1, with 0 artifact(s)');
  });

  it('reports a failure to read as a tool error', async () => {
    const { call } = harness({
      task: async () => {
        throw new Error('no such task');
      },
    });

    const result = await call('a2a_task', { taskId: 'nope' });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('A2A call failed: no such task');
  });
});

describe('a2a_cancel', () => {
  it('renders a cancelled task exactly as a read does', async () => {
    // Cancelling late does not unmake the work: the ACP bridge publishes its artifact
    // before it reports CANCELED, and a caller should not have to fetch it again.
    const { call } = harness({
      cancel: async () =>
        snapshot({
          state: TaskState.TASK_STATE_CANCELED,
          status: 'Cancelled. Its answer is in the artifact.',
        }),
    });

    const result = await call('a2a_cancel', { taskId: 'task-1' });

    expect(textOf(result)).toContain('Task task-1 is TASK_STATE_CANCELED');
    expect(textOf(result)).toContain('recovered answer');
    expect(result.isError).toBeUndefined();
  });

  it('passes a refusal on — a task that would not cancel is worth knowing about', async () => {
    const { call } = harness({
      cancel: async () => {
        throw new Error('TASK_NOT_CANCELABLE');
      },
    });

    const result = await call('a2a_cancel', { taskId: 'task-1' });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('TASK_NOT_CANCELABLE');
  });
});

describe('a2a_card', () => {
  it('renders who the agent is and what it declares it can do', async () => {
    const { call } = harness({
      card: async () =>
        ({
          name: 'Claude (via ACP)',
          version: '0.1.0',
          description: 'An A2A front for claude-agent-acp',
          skills: [{ id: 'acp_prompt', description: 'Forwards the request to Claude' }],
        }) as Awaited<ReturnType<A2APool['card']>>,
    });

    const result = await call('a2a_card', {});

    expect(textOf(result)).toContain('Claude (via ACP) (v0.1.0)');
    expect(textOf(result)).toContain('acp_prompt — Forwards the request to Claude');
    expect(envelopeOf(result)).toMatchObject({ name: 'Claude (via ACP)' });
  });

  it('renders a card that declares no skills at all', async () => {
    const { call } = harness({
      card: async () => ({ name: 'Bare', version: '0.0.1', description: '' }) as Awaited<ReturnType<A2APool['card']>>,
    });

    expect(textOf(await call('a2a_card', {}))).toContain('Bare (v0.0.1)');
  });

  it('reports an unreachable agent rather than an empty card', async () => {
    const { call } = harness({
      card: async () => {
        throw new Error('agent card http://agent.local/.well-known/agent-card.json: HTTP 404');
      },
    });

    expect(await call('a2a_card', {})).toMatchObject({ isError: true });
  });
});
