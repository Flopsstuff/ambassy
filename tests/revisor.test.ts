/**
 * The stub agent: what it computes, and the event cycle it publishes while doing it.
 *
 * `SUBMITTED → WORKING → artifact → COMPLETED` is the sequence AGENTS.md names as the
 * way to check the repository still works, so it is asserted here rather than left to a
 * human watching `yarn client` scroll past.
 */
import { TaskState, type Task } from '@a2a-js/sdk';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RevisorExecutor, analyze } from '../src/revisor.ts';
import { collect, requestContext, userMessage } from './helpers/a2a.ts';

// The executor narrates itself to stdout on purpose; a test run is not the audience.
beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

// Zero delay everywhere: the pause exists so a human sees two WORKING frames arrive
// separately, and nothing about the events depends on how long it takes.
const executor = () => new RevisorExecutor({ stepDelayMs: 0 });

describe('analyze', () => {
  it('counts characters, words and sentences', () => {
    const stats = analyze('One fish. Two fish! Red fish?');

    expect(stats.characters).toBe(29);
    expect(stats.words).toBe(6);
    expect(stats.sentences).toBe(3);
  });

  it('rounds the average word length to two decimals', () => {
    // 'aa' + 'bbbb' = 6 characters over 2 words.
    expect(analyze('aa bbbb').averageWordLength).toBe(3);
    // 'a' + 'bb' = 3 over 2, which is where the rounding shows.
    expect(analyze('a bb').averageWordLength).toBe(1.5);
  });

  it('reports zero average length for an empty text rather than NaN', () => {
    const stats = analyze('   ');

    expect(stats.words).toBe(0);
    expect(stats.averageWordLength).toBe(0);
    expect(stats.topWords).toEqual([]);
  });

  it('counts frequencies case-insensitively and ignores punctuation', () => {
    const stats = analyze('Protocol, protocol; PROTOCOL — agent agent.');

    expect(stats.topWords).toEqual([
      { word: 'protocol', count: 3 },
      { word: 'agent', count: 2 },
    ]);
  });

  it('leaves out words of three characters or fewer', () => {
    // Otherwise the top of every list is "the", "and", "a", and says nothing.
    const stats = analyze('the the the and and cat cats');

    expect(stats.topWords).toEqual([{ word: 'cats', count: 1 }]);
  });

  it('keeps letters outside ASCII and the hyphen inside a word', () => {
    const stats = analyze('приветствие приветствие well-known well-known');

    expect(stats.topWords).toEqual([
      { word: 'приветствие', count: 2 },
      { word: 'well-known', count: 2 },
    ]);
  });

  it('keeps at most five words in the frequency list', () => {
    const stats = analyze('aaaa bbbb cccc dddd eeee ffff gggg');

    expect(stats.topWords).toHaveLength(5);
  });
});

describe('RevisorExecutor.execute', () => {
  it('publishes a task first, then works, then delivers an artifact', async () => {
    const { bus, events, states, artifacts } = collect();

    await executor().execute(requestContext({ text: 'Two words.' }), bus);

    // PROTOCOL RULE: a stream that opens with anything but a task or a message is
    // rejected by the server.
    expect(events[0].kind).toBe('task');
    expect(states()).toEqual(['TASK_STATE_WORKING', 'TASK_STATE_WORKING', 'TASK_STATE_COMPLETED']);
    // The artifact goes out before the terminal status, so a client that stops reading
    // at COMPLETED has already seen the result.
    expect(events.at(-2)?.kind).toBe('artifactUpdate');

    const [artifact] = artifacts();
    expect(artifact.name).toBe('text-stats');
    expect(artifact.text).toContain('Words: 2');
    expect(artifact.data).toMatchObject({ words: 2, sentences: 1 });
  });

  it('opens a new task in SUBMITTED', async () => {
    const { bus, events } = collect();

    await executor().execute(requestContext({ text: 'anything' }), bus);

    const first = events[0] as { data: Task };
    expect(first.data.status.state).toBe(TaskState.TASK_STATE_SUBMITTED);
    expect(first.data.history).toHaveLength(1);
  });

  it('asks for input instead of failing when the message carries no text', async () => {
    const { bus, states, said, artifacts } = collect();

    await executor().execute(requestContext({ text: '' }), bus);

    // INPUT_REQUIRED is not terminal: the task stays open for the next turn.
    expect(states()).toEqual(['TASK_STATE_INPUT_REQUIRED']);
    expect(said()[0]).toContain('reply into this same task');
    expect(artifacts()).toEqual([]);
  });

  it('republishes the stored task when a turn continues an existing one', async () => {
    const existing: Task = {
      id: 'task-1111-2222',
      contextId: 'ctx-3333-4444',
      status: { state: TaskState.TASK_STATE_INPUT_REQUIRED, timestamp: '2026-01-01T00:00:00.000Z', message: undefined },
      artifacts: [],
      history: [userMessage('', 'task-1111-2222', 'ctx-3333-4444')],
      metadata: {},
    };
    const { bus, events, states } = collect();

    await executor().execute(requestContext({ text: 'now with text', task: existing }), bus);

    // The first event is still a task — the same one, not a fresh SUBMITTED snapshot.
    expect((events[0] as { data: Task }).data.status.state).toBe(TaskState.TASK_STATE_INPUT_REQUIRED);
    expect(states().at(-1)).toBe('TASK_STATE_COMPLETED');
  });

  it('stops at the next step boundary once the task is cancelled', async () => {
    const { bus, states, artifacts } = collect();
    const revisor = executor();

    await revisor.cancelTask('task-1111-2222');
    await revisor.execute(requestContext({ text: 'text that will not be analysed' }), bus);

    expect(states()).toEqual(['TASK_STATE_WORKING', 'TASK_STATE_CANCELED']);
    expect(artifacts()).toEqual([]);
  });

  it('forgets the cancellation afterwards, so the next task is not killed by it', async () => {
    const revisor = executor();
    await revisor.cancelTask('task-1111-2222');

    const first = collect();
    await revisor.execute(requestContext({ text: 'first' }), first.bus);
    expect(first.states().at(-1)).toBe('TASK_STATE_CANCELED');

    const second = collect();
    await revisor.execute(requestContext({ text: 'second' }), second.bus);
    expect(second.states().at(-1)).toBe('TASK_STATE_COMPLETED');
  });
});
