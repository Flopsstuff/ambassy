/**
 * The translation table from AGENTS.md, asserted one row at a time.
 *
 * | ACP                          | A2A                                           |
 * | agent_message_chunk          | WORKING + text, coalesced, kept for the artifact |
 * | agent_thought_chunk          | WORKING, marked as thinking                   |
 * | tool_call / tool_call_update | WORKING, updates only on a status change      |
 * | plan                         | WORKING, the entries as a list                |
 * | stop: end_turn               | artifactUpdate + COMPLETED                    |
 * | stop: cancelled              | CANCELED, with the refusal reason             |
 * | stop: refusal                | FAILED                                        |
 * | stop: max_tokens             | COMPLETED, the reason in the data part        |
 *
 * The runtime is a fake, because what is under test is the translation and not the
 * subprocess: `TurnRuntime` exists as an interface for exactly this reason.
 */
import { RequestError, type ActiveSessionMessage, type SessionUpdate, type StopReason, type Usage } from '@agentclientprotocol/sdk';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BACKENDS, type Budget } from '../../src/acp/client.ts';
import { AcpExecutor, describeError, type RuntimeSource, type TurnRuntime } from '../../src/acp/executor.ts';
import { collect, requestContext } from '../helpers/a2a.ts';
import { recordingLogs, type RecordingLogs } from '../helpers/logs.ts';

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

const CLAUDE = BACKENDS.claude;

// --- the ACP side, as an ActiveSession would hand it over ---

const update = (sessionUpdate: SessionUpdate): ActiveSessionMessage =>
  ({ kind: 'session_update', notification: { sessionId: 'sess-1', update: sessionUpdate }, update: sessionUpdate }) as ActiveSessionMessage;

const says = (text: string): ActiveSessionMessage =>
  update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } } as SessionUpdate);

const thinks = (text: string): ActiveSessionMessage =>
  update({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text } } as SessionUpdate);

const toolCall = (over: Record<string, unknown> = {}): ActiveSessionMessage =>
  update({
    sessionUpdate: 'tool_call',
    toolCallId: 'tc-1',
    title: 'Read notes.md',
    kind: 'read',
    status: 'pending',
    ...over,
  } as SessionUpdate);

const toolUpdate = (over: Record<string, unknown> = {}): ActiveSessionMessage =>
  update({ sessionUpdate: 'tool_call_update', toolCallId: 'tc-1', status: 'completed', ...over } as SessionUpdate);

const plan = (entries: { status: string; content: string }[]): ActiveSessionMessage =>
  update({ sessionUpdate: 'plan', entries } as unknown as SessionUpdate);

const stops = (stopReason: StopReason, usage?: Usage | null): ActiveSessionMessage =>
  ({ kind: 'stop', stopReason, response: { stopReason, usage } }) as unknown as ActiveSessionMessage;

// --- the runtime the executor prompts ---

interface FakeRuntime extends TurnRuntime {
  prompts: string[];
  cancels: number;
  turnMarkers: (string | undefined)[];
}

const NOTHING_MORE = new Promise<ActiveSessionMessage>(() => {});

const fakeRuntime = (messages: ActiveSessionMessage[], opts: { denials?: string[]; promptFails?: Error } = {}): FakeRuntime => {
  const queue = [...messages];
  const prompts: string[] = [];
  const turnMarkers: (string | undefined)[] = [];
  let denials: string[] = [];
  let refused = false;
  let cancels = 0;
  const total: Budget = {
    turns: 0,
    totalTokens: 0,
    inputTokens: 0,
    outputTokens: 0,
    cachedReadTokens: 0,
    cachedWriteTokens: 0,
  };

  return {
    prompts,
    cancels: 0,
    turnMarkers,
    openTasks: new Set<string>(),
    sessionId: 'sess-abcdef12',
    boundary: { root: '/tmp/sandbox', owned: true, allowExecute: false },
    session: {
      prompt: (async (text: string) => {
        prompts.push(String(text));
        if (opts.promptFails) throw opts.promptFails;
        // The real prompt resolves when the turn ends; the loop reads the same
        // completion off the update queue as a `stop` message.
        return { stopReason: 'end_turn' };
      }) as TurnRuntime['session']['prompt'],
      nextUpdate: (() => {
        // A refusal is recorded while the turn runs — the executor drops leftovers from
        // an earlier one before prompting, so seeding them upfront would prove nothing.
        if (!refused) {
          refused = true;
          denials = [...(opts.denials ?? [])];
        }
        return queue.length ? Promise.resolve(queue.shift()!) : NOTHING_MORE;
      }) as TurnRuntime['session']['nextUpdate'],
    },
    run: (fn) => fn(),
    takeDenials: () => {
      const taken = denials;
      denials = [];
      return taken;
    },
    addUsage: (usage) => {
      total.turns += 1;
      if (usage) {
        total.totalTokens += usage.totalTokens ?? 0;
        total.inputTokens += usage.inputTokens ?? 0;
      }
      return { ...total };
    },
    beginTurn: (taskId) => void turnMarkers.push(taskId),
    endTurn: () => void turnMarkers.push(undefined),
    notifyCancel: async function () {
      cancels += 1;
      (this as FakeRuntime).cancels = cancels;
    },
  };
};

interface Harness {
  executor: AcpExecutor;
  runtime: FakeRuntime;
  logs: RecordingLogs;
  acquired: string[];
}

const harness = (
  messages: ActiveSessionMessage[],
  opts: { denials?: string[]; promptFails?: Error; acquireFails?: Error } = {},
): Harness => {
  const runtime = fakeRuntime(messages, opts);
  const logs = recordingLogs();
  const acquired: string[] = [];
  const source: RuntimeSource = {
    acquire: async (contextId) => {
      acquired.push(contextId);
      if (opts.acquireFails) throw opts.acquireFails;
      return runtime;
    },
  };
  return { executor: new AcpExecutor(source, logs, CLAUDE), runtime, logs, acquired };
};

describe('the shape of a turn', () => {
  it('publishes a task first, then the work, then an artifact and COMPLETED', async () => {
    const { executor } = harness([says('Hello.'), stops('end_turn')]);
    const { bus, events, states, artifacts } = collect();

    await executor.execute(requestContext({ text: 'say hello' }), bus);

    // PROTOCOL RULE: a stream that opens with a status update is rejected by the server.
    expect(events[0].kind).toBe('task');
    expect(states()).toEqual(['TASK_STATE_WORKING', 'TASK_STATE_COMPLETED']);
    expect(events.at(-2)?.kind).toBe('artifactUpdate');
    expect(artifacts()[0]).toMatchObject({ name: 'acp-answer', text: 'Hello.' });
  });

  it('asks for input when the message carries no text, and keeps the adapter', async () => {
    const { executor, runtime, logs } = harness([]);
    const { bus, states, said } = collect();

    await executor.execute(requestContext({ text: '' }), bus);

    expect(states()).toEqual(['TASK_STATE_INPUT_REQUIRED']);
    expect(said()[0]).toContain('Claude picks it up');
    // A task parked in INPUT_REQUIRED keeps the adapter alive, or the follow-up turn
    // would land in a session that never heard the question.
    expect([...runtime.openTasks]).toEqual(['task-1111-2222']);
    expect(runtime.prompts).toEqual([]);
    expect(logs.last('task.input_required')).toMatchObject({ sessionId: 'sess-abcdef12' });
  });

  it('releases the adapter once the task is terminal', async () => {
    const { executor, runtime } = harness([stops('end_turn')]);
    const { bus } = collect();

    await executor.execute(requestContext({ text: 'work' }), bus);

    expect([...runtime.openTasks]).toEqual([]);
  });

  it('tells the permission handlers which task they are deciding for, and stops afterwards', async () => {
    const { executor, runtime } = harness([stops('end_turn')]);
    const { bus } = collect();

    await executor.execute(requestContext({ text: 'work' }), bus);

    expect(runtime.turnMarkers[0]).toBe('task-1111-2222');
    expect(runtime.turnMarkers.at(-1)).toBeUndefined();
  });
});

describe('agent_message_chunk', () => {
  it('coalesces short pieces into one frame', async () => {
    // Codex streams one token per update; forwarded verbatim they bury the wire.
    const { executor } = harness([says('one '), says('two '), says('three'), stops('end_turn')]);
    const { bus, said, artifacts } = collect();

    await executor.execute(requestContext({ text: 'count' }), bus);

    expect(said().filter(Boolean)).toEqual(['one two three']);
    expect(artifacts()[0].text).toBe('one two three');
  });

  it('flushes on a newline', async () => {
    const { executor } = harness([says('first line\n'), says('second line'), stops('end_turn')]);
    const { bus, said } = collect();

    await executor.execute(requestContext({ text: 'x' }), bus);

    expect(said().filter(Boolean)).toEqual(['first line', 'second line']);
  });

  it('flushes once the pending text passes 160 characters', async () => {
    const long = 'z'.repeat(170);
    const { executor } = harness([says(long), says('tail'), stops('end_turn')]);
    const { bus, said } = collect();

    await executor.execute(requestContext({ text: 'x' }), bus);

    expect(said().filter(Boolean)).toEqual([long, 'tail']);
  });

  it('names a content type it cannot render instead of dropping it', async () => {
    const { executor } = harness([
      update({ sessionUpdate: 'agent_message_chunk', content: { type: 'image', data: '…', mimeType: 'image/png' } } as SessionUpdate),
      stops('end_turn'),
    ]);
    const { bus, artifacts } = collect();

    await executor.execute(requestContext({ text: 'x' }), bus);

    expect(artifacts()[0].text).toBe('<image>');
  });
});

describe('agent_thought_chunk', () => {
  it('marks thinking as thinking and keeps it out of the answer', async () => {
    const { executor } = harness([thinks('the user wants X'), says('Here is X.'), stops('end_turn')]);
    const { bus, said, artifacts } = collect();

    await executor.execute(requestContext({ text: 'x' }), bus);

    expect(said().filter(Boolean)).toEqual(['thinking: the user wants X', 'Here is X.']);
    // The artifact is the answer, not the deliberation that led to it.
    expect(artifacts()[0].text).toBe('Here is X.');
  });

  it('flushes the answer before switching channels', async () => {
    const { executor } = harness([says('partial'), thinks('hmm'), stops('end_turn')]);
    const { bus, said } = collect();

    await executor.execute(requestContext({ text: 'x' }), bus);

    expect(said().filter(Boolean)).toEqual(['partial', 'thinking: hmm']);
  });

  it('ignores a thought that is not text', async () => {
    const { executor } = harness([
      update({ sessionUpdate: 'agent_thought_chunk', content: { type: 'image', data: '…', mimeType: 'image/png' } } as SessionUpdate),
      stops('end_turn'),
    ]);
    const { bus, said } = collect();

    await executor.execute(requestContext({ text: 'x' }), bus);

    expect(said().filter(Boolean)).toEqual([]);
  });
});

describe('tool calls', () => {
  it('announces a tool call and records it with its locations', async () => {
    const { executor, logs } = harness([
      toolCall({ locations: [{ path: '/tmp/sandbox/notes.md' }] }),
      stops('end_turn'),
    ]);
    const { bus, said } = collect();

    await executor.execute(requestContext({ text: 'read it' }), bus);

    expect(said().filter(Boolean)).toEqual(['«Read notes.md» (read, pending)']);
    expect(logs.last('tool.call')).toMatchObject({
      toolCallId: 'tc-1',
      kind: 'read',
      status: 'pending',
      locations: ['/tmp/sandbox/notes.md'],
      taskId: 'task-1111-2222',
      sessionId: 'sess-abcdef12',
    });
  });

  it('defaults a call that declares neither kind nor status', async () => {
    const { executor } = harness([
      update({ sessionUpdate: 'tool_call', toolCallId: 'tc-2', title: 'Something' } as SessionUpdate),
      stops('end_turn'),
    ]);
    const { bus, said } = collect();

    await executor.execute(requestContext({ text: 'x' }), bus);

    expect(said().filter(Boolean)).toEqual(['«Something» (other, pending)']);
  });

  it('forwards an update only when the status actually changed', async () => {
    const { executor, logs } = harness([
      toolCall(),
      toolUpdate({ status: 'pending' }), // no change: not worth a frame
      toolUpdate({ status: 'in_progress' }),
      toolUpdate({ status: 'in_progress' }),
      toolUpdate({ status: 'completed' }),
      stops('end_turn'),
    ]);
    const { bus, said } = collect();

    await executor.execute(requestContext({ text: 'x' }), bus);

    expect(said().filter(Boolean)).toEqual([
      '«Read notes.md» (read, pending)',
      '«Read notes.md» → in_progress',
      '«Read notes.md» → completed',
    ]);
    expect(logs.names('work').filter((e) => e === 'tool.update')).toHaveLength(2);
  });

  it('ignores an update for a call it never saw start', async () => {
    const { executor } = harness([toolUpdate({ toolCallId: 'unknown' }), stops('end_turn')]);
    const { bus, said } = collect();

    await executor.execute(requestContext({ text: 'x' }), bus);

    expect(said().filter(Boolean)).toEqual([]);
  });

  it('counts a failed tool call in the artifact and in the closing note', async () => {
    // Codex reports a terminal failure as end_turn, which is why failed calls are
    // counted rather than inferred from the stop reason.
    const { executor } = harness([toolCall(), toolUpdate({ status: 'failed' }), stops('end_turn')]);
    const { bus, said, artifacts } = collect();

    await executor.execute(requestContext({ text: 'x' }), bus);

    expect(artifacts()[0].data).toMatchObject({ failedToolCalls: 1 });
    expect(said().at(-1)).toBe('Done, but 1 tool call(s) failed.');
  });
});

describe('plan', () => {
  it('forwards the entries as a list and logs them', async () => {
    const { executor, logs } = harness([
      plan([
        { status: 'pending', content: 'read the file' },
        { status: 'in_progress', content: 'write the answer' },
      ]),
      stops('end_turn'),
    ]);
    const { bus, said } = collect();

    await executor.execute(requestContext({ text: 'x' }), bus);

    expect(said().filter(Boolean)).toEqual(['plan:\n· [pending] read the file\n· [in_progress] write the answer']);
    expect(logs.last('plan')).toMatchObject({
      entries: [
        { status: 'pending', content: 'read the file' },
        { status: 'in_progress', content: 'write the answer' },
      ],
    });
  });
});

describe('updates the bridge does not surface', () => {
  it('ignores a vendor update instead of failing the turn', async () => {
    // The union is closed in TypeScript, but agents are allowed to invent their own.
    const { executor } = harness([
      update({ sessionUpdate: 'something_vendor_specific', payload: { anything: true } } as unknown as SessionUpdate),
      says('done'),
      stops('end_turn'),
    ]);
    const { bus, states } = collect();

    await executor.execute(requestContext({ text: 'x' }), bus);

    expect(states().at(-1)).toBe('TASK_STATE_COMPLETED');
  });
});

describe('how a turn ends', () => {
  it('puts the whole envelope in the artifact', async () => {
    const usage: Usage = { totalTokens: 120, inputTokens: 100, outputTokens: 20 } as Usage;
    const { executor } = harness([toolCall(), says('done'), stops('end_turn', usage)]);
    const { bus, artifacts } = collect();

    await executor.execute(requestContext({ text: 'x' }), bus);

    expect(artifacts()[0].data).toMatchObject({
      backend: 'claude',
      sessionId: 'sess-abcdef12',
      root: '/tmp/sandbox',
      stopReason: 'end_turn',
      failedToolCalls: 0,
      refusedByBridge: [],
      usage,
    });
    expect((artifacts()[0].data as { toolCalls: unknown[] }).toolCalls).toHaveLength(1);
  });

  it('says something rather than nothing when the agent produced no text', async () => {
    const { executor } = harness([stops('end_turn')]);
    const { bus, artifacts } = collect();

    await executor.execute(requestContext({ text: 'x' }), bus);

    expect(artifacts()[0].text).toBe('(the agent finished the turn without saying anything)');
  });

  it('completes quietly when nothing went wrong', async () => {
    const { executor } = harness([says('fine'), stops('end_turn')]);
    const { bus, said } = collect();

    await executor.execute(requestContext({ text: 'x' }), bus);

    expect(said().at(-1)).toBe('');
  });

  it('names the refusals in the closing note', async () => {
    const { executor } = harness([says('partly done'), stops('end_turn')], {
      denials: ['rm -rf /: execute is unverifiable'],
    });
    const { bus, said, artifacts } = collect();

    await executor.execute(requestContext({ text: 'x' }), bus);

    expect(said().at(-1)).toBe('Done, but 1 action(s) refused by the bridge.');
    expect(artifacts()[0].data).toMatchObject({ refusedByBridge: ['rm -rf /: execute is unverifiable'] });
  });

  it.each([
    ['max_tokens' as StopReason],
    ['max_turn_requests' as StopReason],
  ])('completes on %s and says the turn stopped early', async (stopReason) => {
    // A ceiling is not an error: the turn did end, and the reason travels in the data part.
    const { executor } = harness([says('as far as I got'), stops(stopReason)]);
    const { bus, states, said, artifacts } = collect();

    await executor.execute(requestContext({ text: 'x' }), bus);

    expect(states().at(-1)).toBe('TASK_STATE_COMPLETED');
    expect(said().at(-1)).toBe(`Stopped early: ${stopReason}.`);
    expect(artifacts()[0].data).toMatchObject({ stopReason });
  });

  it('fails on a refusal, with whatever the agent said about it', async () => {
    const { executor } = harness([says('I will not do that.'), stops('refusal')]);
    const { bus, states, said, artifacts } = collect();

    await executor.execute(requestContext({ text: 'x' }), bus);

    expect(states().at(-1)).toBe('TASK_STATE_FAILED');
    expect(said().at(-1)).toBe('I will not do that.');
    // A refusal produces no artifact: there is no answer to keep.
    expect(artifacts()).toEqual([]);
  });

  it('fails on a wordless refusal with a sentence of its own', async () => {
    const { executor } = harness([stops('refusal')]);
    const { bus, said } = collect();

    await executor.execute(requestContext({ text: 'x' }), bus);

    expect(said().at(-1)).toBe('Claude refused the request.');
  });
});

describe('cancellation', () => {
  it('sends session/cancel when there is a session to send it to', async () => {
    const { executor, runtime, logs } = harness([says('working'), stops('cancelled')]);
    const { bus, states } = collect();

    const running = executor.execute(requestContext({ text: 'long job' }), bus);
    // The first frame is the task, published before the adapter is acquired, so a client
    // can react to it while the session is still being set up.
    await Promise.resolve();
    await executor.cancelTask('task-1111-2222');
    await running;

    expect(runtime.cancels).toBe(1);
    expect(logs.last('task.cancel')).toMatchObject({ phase: 'session/cancel' });
    expect(states().at(-1)).toBe('TASK_STATE_CANCELED');
  });

  it('records a cancel that arrived before there was a session', async () => {
    const { executor, logs } = harness([stops('end_turn')]);

    await executor.cancelTask('task-1111-2222');

    expect(logs.last('task.cancel')).toMatchObject({ phase: 'no-session' });
  });

  it('stops before prompting when the cancel beat the adapter', async () => {
    const { executor, runtime } = harness([stops('end_turn')]);
    const { bus, states, said } = collect();

    await executor.cancelTask('task-1111-2222');
    await executor.execute(requestContext({ text: 'never sent' }), bus);

    expect(runtime.prompts).toEqual([]);
    expect(states()).toEqual(['TASK_STATE_CANCELED']);
    expect(said().at(-1)).toBe('Cancelled before the request reached the agent.');
  });

  it('explains a cancel the bridge itself caused', async () => {
    // Codex offers no gentler refusal than aborting the turn on a file edit, so a
    // classifier denial and a client CancelTask arrive here as the same stop reason.
    const { executor } = harness([stops('cancelled')], { denials: ['Write /etc/hosts: edit escapes the root'] });
    const { bus, said } = collect();

    await executor.execute(requestContext({ text: 'x' }), bus);

    expect(said().at(-1)).toBe('Refused by the bridge: Write /etc/hosts: edit escapes the root');
  });

  it('reports CANCELED even when the agent had already finished the turn', async () => {
    // CancelTask only clears if the stored state ends up CANCELED — anything else comes
    // back as -32002 TASK_NOT_CANCELABLE — and the caller is owed that answer.
    const { executor } = harness([says('finished anyway'), stops('end_turn')]);
    const { bus, states, said, artifacts } = collect();

    const running = executor.execute(requestContext({ text: 'x' }), bus);
    await Promise.resolve();
    await executor.cancelTask('task-1111-2222');
    await running;

    // The artifact goes out first: the work that did happen is not thrown away.
    expect(artifacts()[0].text).toBe('finished anyway');
    expect(states().at(-1)).toBe('TASK_STATE_CANCELED');
    expect(said().at(-1)).toContain('its answer is in the artifact');
  });

  it('forgets the cancellation, so the next task in the same conversation runs', async () => {
    const { executor } = harness([stops('end_turn')]);
    const first = collect();
    await executor.cancelTask('task-1111-2222');
    await executor.execute(requestContext({ text: 'one' }), first.bus);
    expect(first.states().at(-1)).toBe('TASK_STATE_CANCELED');

    const second = collect();
    await executor.execute(requestContext({ text: 'two' }), second.bus);
    expect(second.states().at(-1)).toBe('TASK_STATE_COMPLETED');
  });
});

describe('failures', () => {
  it('fails the task when the adapter will not start', async () => {
    const { executor, logs } = harness([], { acquireFails: new Error('spawn ENOENT') });
    const { bus, events, states, said } = collect();

    await executor.execute(requestContext({ text: 'x' }), bus);

    // The task event still goes out first — the stream has to open legally even when
    // everything behind it is broken.
    expect(events[0].kind).toBe('task');
    expect(states()).toEqual(['TASK_STATE_FAILED']);
    expect(said().at(-1)).toBe('spawn ENOENT');
    expect(logs.last('task.failed')).toMatchObject({ reason: 'spawn ENOENT' });
  });

  it('fails the task when the prompt itself is rejected', async () => {
    const { executor } = harness([], { promptFails: new Error('session is gone') });
    const { bus, states, said } = collect();

    await executor.execute(requestContext({ text: 'x' }), bus);

    expect(states()).toEqual(['TASK_STATE_FAILED']);
    expect(said().at(-1)).toBe('session is gone');
  });

  it('translates the not-logged-in error both adapters answer with', async () => {
    const { executor } = harness([], { acquireFails: RequestError.authRequired() });
    const { bus, said } = collect();

    await executor.execute(requestContext({ text: 'x' }), bus);

    expect(said().at(-1)).toBe('Claude is not authenticated — log in with its own CLI, then restart the bridge');
  });
});

describe('describeError', () => {
  it('names the backend when the CLI is not logged in', () => {
    expect(describeError(RequestError.authRequired(), BACKENDS.codex)).toContain('Codex is not authenticated');
  });

  it('passes another RequestError through as its own message', () => {
    expect(describeError(RequestError.invalidParams(undefined, 'bad cwd'), BACKENDS.claude)).toContain('bad cwd');
  });

  it('stringifies something that is not an Error at all', () => {
    expect(describeError('just a string', BACKENDS.claude)).toBe('just a string');
  });
});

describe('what the call log records', () => {
  it('bookends a turn with prompt.start and prompt.stop, budget included', async () => {
    const usage: Usage = { totalTokens: 120, inputTokens: 100, outputTokens: 20 } as Usage;
    const { executor, logs } = harness([toolCall(), says('done'), stops('end_turn', usage)]);
    const { bus } = collect();

    await executor.execute(requestContext({ text: 'x' }), bus);

    expect(logs.names('call')).toEqual(['task.start', 'prompt.start', 'prompt.stop', 'task.finish']);
    expect(logs.last('prompt.stop')).toMatchObject({
      stopReason: 'end_turn',
      toolCalls: 1,
      failedToolCalls: 0,
      cancelRequested: false,
      usage,
      // usage is one turn; budget is what the conversation has cost so far.
      budget: { turns: 1, totalTokens: 120 },
    });
    expect(logs.last('task.finish')).toMatchObject({ state: 'TASK_STATE_COMPLETED', stopReason: 'end_turn' });
  });

  it('records a turn that cost nothing, rather than skipping the budget', async () => {
    const { executor, logs } = harness([stops('end_turn')]);
    const { bus } = collect();

    await executor.execute(requestContext({ text: 'x' }), bus);

    expect(logs.last('prompt.stop')).toMatchObject({ usage: null, budget: { turns: 1, totalTokens: 0 } });
  });
});
