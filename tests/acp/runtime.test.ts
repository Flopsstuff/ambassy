/**
 * The per-conversation bookkeeping: one turn at a time, a running token budget, and the
 * idle clock the reaper reads.
 *
 * The child process and the ACP connection are fakes. What is under test never speaks
 * to either — it counts, queues and decides when a conversation has gone quiet.
 */
import { EventEmitter } from 'node:events';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import type { ActiveSession, ClientConnection, Usage } from '@agentclientprotocol/sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Runtime } from '../../src/acp/client.ts';
import type { Boundary } from '../../src/acp/permissions.ts';

const BOUNDARY: Boundary = { root: '/tmp/sandbox', owned: true, allowExecute: false };

class FakeChild extends EventEmitter {
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  stdinEnded = false;
  killed: string | null = null;
  readonly stdin = { end: () => void (this.stdinEnded = true) };

  kill(signal: string): void {
    this.killed = signal;
  }

  exit(code: number): void {
    this.exitCode = code;
    this.emit('exit', code, null);
  }
}

const build = (state: { taskId?: string; denials: string[] } = { denials: [] }) => {
  const child = new FakeChild();
  const notifications: { method: unknown; params: unknown }[] = [];
  let closed = false;
  let disposed = false;
  const conn = {
    agent: {
      notify: async (method: unknown, params: unknown) => void notifications.push({ method, params }),
    },
    close: () => void (closed = true),
  } as unknown as ClientConnection;
  const session = { sessionId: 'sess-abcdef12', dispose: () => void (disposed = true) } as unknown as ActiveSession;

  const runtime = new Runtime(
    'ctx-1',
    BOUNDARY,
    child as unknown as ChildProcessWithoutNullStreams,
    conn,
    session,
    state,
  );
  return {
    runtime,
    child,
    state,
    notifications,
    isClosed: () => closed,
    isDisposed: () => disposed,
  };
};

afterEach(() => {
  vi.useRealTimers();
});

describe('identity', () => {
  it('reports the conversation, the session and the root it was given', () => {
    const { runtime } = build();

    expect(runtime.contextId).toBe('ctx-1');
    expect(runtime.sessionId).toBe('sess-abcdef12');
    expect(runtime.boundary).toEqual(BOUNDARY);
  });
});

describe('the turn marker', () => {
  it('writes into the very object the permission handlers read', () => {
    // Shared, not copied: that is what lets a decision in work.jsonl name its task.
    const state = { denials: [] as string[] };
    const { runtime } = build(state);

    runtime.beginTurn('task-1');
    expect(state.taskId).toBe('task-1');

    runtime.endTurn();
    expect(state.taskId).toBeUndefined();
  });

  it('takes the refusals recorded since the last call, and leaves none behind', () => {
    const state = { denials: ['first refusal'] };
    const { runtime } = build(state);

    expect(runtime.takeDenials()).toEqual(['first refusal']);
    expect(runtime.takeDenials()).toEqual([]);
    expect(state.denials).toEqual([]);
  });
});

describe('the token budget', () => {
  const usage = (over: Partial<Usage>): Usage => over as Usage;

  it('starts at nothing', () => {
    expect(build().runtime.budget).toEqual({
      turns: 0,
      totalTokens: 0,
      inputTokens: 0,
      outputTokens: 0,
      cachedReadTokens: 0,
      cachedWriteTokens: 0,
    });
  });

  it('adds one turn at a time, field by field', () => {
    const { runtime } = build();

    runtime.addUsage(usage({ totalTokens: 100, inputTokens: 80, outputTokens: 20, cachedReadTokens: 5 }));
    const budget = runtime.addUsage(usage({ totalTokens: 50, inputTokens: 40, outputTokens: 10, cachedWriteTokens: 7 }));

    expect(budget).toEqual({
      turns: 2,
      totalTokens: 150,
      inputTokens: 120,
      outputTokens: 30,
      cachedReadTokens: 5,
      cachedWriteTokens: 7,
    });
  });

  it('counts a turn that reported no usage at all', () => {
    // Codex sends none; the turn still happened, and the count still says so.
    const { runtime } = build();

    expect(runtime.addUsage(null)).toMatchObject({ turns: 1, totalTokens: 0 });
    expect(runtime.addUsage(undefined)).toMatchObject({ turns: 2 });
  });

  it('hands out a copy, so a caller cannot edit the total it was shown', () => {
    const { runtime } = build();
    runtime.addUsage(usage({ totalTokens: 10 }));

    const snapshot = runtime.budget;
    snapshot.totalTokens = 999_999;

    expect(runtime.budget.totalTokens).toBe(10);
  });
});

describe('one turn at a time', () => {
  it('runs a second turn only once the first has finished', async () => {
    // Two prompts in one session would interleave in the update queue.
    const { runtime } = build();
    const order: string[] = [];
    let releaseFirst = () => {};
    const first = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const one = runtime.run(async () => {
      order.push('one started');
      await first;
      order.push('one finished');
      return 1;
    });
    const two = runtime.run(async () => {
      order.push('two started');
      return 2;
    });

    // The queue is a promise chain, so the first turn starts a microtask later.
    await Promise.resolve();
    expect(order).toEqual(['one started']);
    releaseFirst();
    expect(await Promise.all([one, two])).toEqual([1, 2]);
    expect(order).toEqual(['one started', 'one finished', 'two started']);
  });

  it('keeps the queue moving after a turn that threw', async () => {
    const { runtime } = build();

    await expect(runtime.run(async () => Promise.reject(new Error('turn failed')))).rejects.toThrow('turn failed');
    await expect(runtime.run(async () => 'next turn')).resolves.toBe('next turn');
  });
});

describe('the idle clock', () => {
  it('counts a conversation as busy while a turn is in flight', async () => {
    vi.useFakeTimers();
    const { runtime } = build();
    let release = () => {};
    const running = runtime.run(() => new Promise<void>((resolve) => void (release = resolve)));
    await Promise.resolve(); // let the queued turn actually start

    vi.advanceTimersByTime(60_000);
    expect(runtime.idleFor(Date.now())).toBe(0);

    release();
    await running;
    vi.advanceTimersByTime(60_000);
    expect(runtime.idleFor(Date.now())).toBe(60_000);
  });

  it('counts it as busy while any task is still open', () => {
    // A task parked in INPUT_REQUIRED keeps the adapter, or the follow-up turn would
    // land in a session that never heard the question.
    vi.useFakeTimers();
    const { runtime } = build();
    runtime.openTasks.add('task-1');

    vi.advanceTimersByTime(600_000);
    expect(runtime.idleFor(Date.now())).toBe(0);

    runtime.openTasks.delete('task-1');
    expect(runtime.idleFor(Date.now())).toBeGreaterThan(0);
  });
});

describe('the child process', () => {
  it('is alive until it exits', () => {
    const { runtime, child } = build();

    expect(runtime.alive).toBe(true);
    child.exit(0);
    expect(runtime.alive).toBe(false);
  });

  it('tells the registry when it goes', () => {
    const { runtime, child } = build();
    const seen: string[] = [];
    runtime.onExit(() => void seen.push('gone'));

    child.exit(1);

    expect(seen).toEqual(['gone']);
  });

  it('cancels through a notification, which is all ACP offers', async () => {
    // session/cancel is a notification, not a request: the turn keeps streaming and
    // closes with stopReason 'cancelled'.
    const { runtime, notifications } = build();

    await runtime.notifyCancel();

    expect(notifications).toHaveLength(1);
    expect(notifications[0].params).toEqual({ sessionId: 'sess-abcdef12' });
  });

  it('shuts down by closing stdin, which is how both adapters are meant to exit', async () => {
    const { runtime, child, isClosed, isDisposed } = build();

    const disposing = runtime.dispose();
    expect(child.stdinEnded).toBe(true);
    child.exit(0);
    await disposing;

    expect(isDisposed()).toBe(true);
    expect(isClosed()).toBe(true);
    expect(child.killed).toBeNull();
  });

  it('kills an adapter that will not take the hint', async () => {
    vi.useFakeTimers();
    const { runtime, child } = build();

    const disposing = runtime.dispose();
    await vi.advanceTimersByTimeAsync(3_000);
    expect(child.killed).toBe('SIGKILL');

    child.exit(137);
    await disposing;
  });

  it('does not wait on a process that has already gone', async () => {
    const { runtime, child } = build();
    child.exit(0);

    await runtime.dispose(); // resolves without an exit event to wait for

    expect(child.stdinEnded).toBe(false);
  });
});
