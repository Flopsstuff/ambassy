/**
 * The heartbeat exists to keep a long tool call alive without also keeping a dead one
 * alive, so both halves are tested: that it ticks while the upstream is producing
 * events, and that it gives up once the upstream has gone quiet for too long.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Heartbeat } from '../../src/mcp/heartbeat.ts';

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

interface Sent {
  progress: number;
  message: string;
}

const beating = (overrides: { everyMs?: number; silenceLimitMs?: number } = {}) => {
  const sent: Sent[] = [];
  const silences: number[] = [];
  const beat = new Heartbeat({
    everyMs: overrides.everyMs ?? 60_000,
    silenceLimitMs: overrides.silenceLimitMs ?? 600_000,
    send: (progress, message) => void sent.push({ progress, message }),
    onSilence: (silentMs) => void silences.push(silentMs),
  });
  return { beat, sent, silences };
};

describe('Heartbeat', () => {
  it('says nothing merely because it was started', () => {
    const { beat, sent } = beating();

    beat.start();

    expect(sent).toEqual([]);
  });

  it('reports a real event immediately', () => {
    const { beat, sent } = beating();
    beat.start();

    beat.touch('reading the file');

    expect(sent).toEqual([{ progress: 1, message: 'reading the file' }]);
  });

  it('counts notifications, because progress must strictly increase', () => {
    // PROTOCOL RULE: `progress` has to increase across the notifications of one request,
    // which is why it is a counter rather than elapsed time or a percentage.
    const { beat, sent } = beating({ everyMs: 1_000 });
    beat.start();

    beat.touch('one');
    beat.touch('two');
    vi.advanceTimersByTime(5_000);

    expect(sent.map((s) => s.progress)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it('ticks on its own once the upstream has been quiet for everyMs', () => {
    const { beat, sent } = beating({ everyMs: 1_000 });
    beat.start();

    vi.advanceTimersByTime(999);
    expect(sent).toEqual([]);

    vi.advanceTimersByTime(1);
    expect(sent).toHaveLength(1);
    expect(sent[0].message).toContain('still working');
  });

  it('repeats the last real message so the tick still says what is happening', () => {
    const { beat, sent } = beating({ everyMs: 1_000 });
    beat.start();

    beat.touch('«Search» (search, pending)');
    vi.advanceTimersByTime(2_000);

    expect(sent.at(-1)?.message).toContain('«Search» (search, pending)');
    expect(sent.at(-1)?.message).toMatch(/\d+s since the last update/);
  });

  it('does not repeat itself right after a real event reported progress', () => {
    const { beat, sent } = beating({ everyMs: 1_000 });
    beat.start();

    vi.advanceTimersByTime(900);
    beat.touch('an event at 900ms');
    vi.advanceTimersByTime(150); // the interval fires at 1000ms, 100ms after the event

    expect(sent).toHaveLength(1);
  });

  it('keeps an empty message from erasing the last one', () => {
    const { beat, sent } = beating({ everyMs: 1_000 });
    beat.start();

    beat.touch('something happened');
    beat.touch('');

    expect(sent.at(-1)?.message).toBe('something happened');
  });

  it('gives up once the silence limit is passed, and says how long it waited', () => {
    // Ticking unconditionally would hide a wedged agent until the client's wall-clock
    // limit, roughly 28 hours away. The idle window is the failure detector.
    const { beat, sent, silences } = beating({ everyMs: 1_000, silenceLimitMs: 5_000 });
    beat.start();

    vi.advanceTimersByTime(5_000);

    expect(silences).toHaveLength(1);
    expect(silences[0]).toBeGreaterThanOrEqual(5_000);
    const beforeGivingUp = sent.length;

    vi.advanceTimersByTime(60_000);
    expect(silences).toHaveLength(1); // reported once, not on every tick
    expect(sent).toHaveLength(beforeGivingUp); // and nothing is sent afterwards
  });

  it('counts the silence from the last event, not from the start', () => {
    const { beat, silences } = beating({ everyMs: 1_000, silenceLimitMs: 5_000 });
    beat.start();

    vi.advanceTimersByTime(4_000);
    beat.touch('still alive');
    vi.advanceTimersByTime(4_000);

    expect(silences).toEqual([]);

    vi.advanceTimersByTime(1_000);
    expect(silences).toHaveLength(1);
  });

  it('stops for good when the turn ends', () => {
    const { beat, sent } = beating({ everyMs: 1_000 });
    beat.start();
    beat.touch('working');

    beat.stop();
    beat.touch('too late');
    vi.advanceTimersByTime(10_000);

    expect(sent).toHaveLength(1);
  });

  it('cannot be restarted after it has stopped', () => {
    const { beat, sent } = beating({ everyMs: 1_000 });
    beat.stop();

    beat.start();
    vi.advanceTimersByTime(10_000);

    expect(sent).toEqual([]);
  });

  it('starting twice does not double the rate', () => {
    const { beat, sent } = beating({ everyMs: 1_000 });

    beat.start();
    beat.start();
    vi.advanceTimersByTime(3_000);

    expect(sent).toHaveLength(3);
  });

  it('refuses to tick faster than four times a second, however small everyMs is', () => {
    const { beat, sent } = beating({ everyMs: 10 });
    beat.start();

    vi.advanceTimersByTime(240);
    expect(sent).toEqual([]);

    vi.advanceTimersByTime(20);
    expect(sent).toHaveLength(1);
  });
});
