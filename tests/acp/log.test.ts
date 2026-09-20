/**
 * The log is hand-written — appending a line, counting bytes, renaming files — so the
 * things a logging library would have guaranteed are asserted here instead: that a
 * record is never split across two files, that the oldest one is dropped rather than
 * kept forever, and that a broken channel takes nothing down with it.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { openLogs, silentLogs, type Fields } from '../../src/acp/log.ts';
import { tempDir } from '../helpers/tmp.ts';

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

const lines = (path: string): Fields[] =>
  readFileSync(path, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Fields);

describe('openLogs', () => {
  it('creates the directory and both channels straight away', () => {
    const dir = join(tempDir('logs'), 'not-yet-there');

    const logs = openLogs({ dir, maxBytes: 1_000, maxFiles: 3 });

    // Created empty rather than on first use: a file that appears only once something
    // interesting happened makes every reader special-case its absence.
    expect(existsSync(join(dir, 'calls.jsonl'))).toBe(true);
    expect(existsSync(join(dir, 'work.jsonl'))).toBe(true);
    expect(statSync(join(dir, 'calls.jsonl')).size).toBe(0);
    expect(logs.dir).toBe(dir);
  });

  it('stamps every record with a timestamp and its event name', () => {
    const dir = tempDir('logs');
    const logs = openLogs({ dir, maxBytes: 1_000_000, maxFiles: 3 });

    logs.call('adapter.spawn', { pid: 42, backend: 'claude' });

    const [record] = lines(join(dir, 'calls.jsonl'));
    expect(record).toMatchObject({ event: 'adapter.spawn', pid: 42, backend: 'claude' });
    expect(new Date(String(record.ts)).toISOString()).toBe(record.ts);
  });

  it('writes an event with no fields at all', () => {
    const dir = tempDir('logs');
    const logs = openLogs({ dir, maxBytes: 1_000_000, maxFiles: 3 });

    logs.work('plan');

    expect(lines(join(dir, 'work.jsonl'))[0]).toMatchObject({ event: 'plan' });
  });

  it('keeps the outward boundary and the inward work in separate files', () => {
    const dir = tempDir('logs');
    const logs = openLogs({ dir, maxBytes: 1_000_000, maxFiles: 3 });

    logs.call('prompt.start', {});
    logs.work('tool.call', {});

    expect(lines(join(dir, 'calls.jsonl')).map((r) => r.event)).toEqual(['prompt.start']);
    expect(lines(join(dir, 'work.jsonl')).map((r) => r.event)).toEqual(['tool.call']);
  });

  it('appends rather than truncating an existing file', () => {
    const dir = tempDir('logs');
    writeFileSync(join(dir, 'calls.jsonl'), `${JSON.stringify({ event: 'from.an.earlier.run' })}\n`);

    openLogs({ dir, maxBytes: 1_000_000, maxFiles: 3 }).call('now', {});

    expect(lines(join(dir, 'calls.jsonl')).map((r) => r.event)).toEqual(['from.an.earlier.run', 'now']);
  });
});

describe('rotation', () => {
  it('moves the live file aside before a write that would overflow it', () => {
    const dir = tempDir('logs');
    const logs = openLogs({ dir, maxBytes: 200, maxFiles: 5 });

    logs.call('first', { pad: 'x'.repeat(150) });
    logs.call('second', { pad: 'y'.repeat(150) });

    // Rotating before the write, never after, is what keeps a record whole.
    expect(lines(join(dir, 'calls.1.jsonl')).map((r) => r.event)).toEqual(['first']);
    expect(lines(join(dir, 'calls.jsonl')).map((r) => r.event)).toEqual(['second']);
  });

  it('never splits a record across two files', () => {
    const dir = tempDir('logs');
    const logs = openLogs({ dir, maxBytes: 300, maxFiles: 5 });

    for (let i = 0; i < 20; i += 1) logs.call('record', { i, pad: 'z'.repeat(100) });

    // Every line in every file has to parse on its own — that is the whole contract, and
    // `lines()` throwing would be how a split record announced itself. What survives is
    // the tail of the run, unbroken: a bounded log drops whole records, never halves.
    const written = readdirSync(dir).filter((f) => f.startsWith('calls'));
    const recovered = written.flatMap((file) => lines(join(dir, file))).map((r) => Number(r.i));
    const ordered = [...recovered].sort((a, b) => a - b);

    expect(recovered.length).toBeGreaterThan(0);
    expect(ordered.at(-1)).toBe(19);
    expect(ordered).toEqual(Array.from(ordered, (_, k) => ordered[0] + k));
  });

  it('shifts the numbered files along and drops the oldest', () => {
    const dir = tempDir('logs');
    const logs = openLogs({ dir, maxBytes: 200, maxFiles: 3 });

    // Each write overflows the previous one, so this is four rotations.
    for (const event of ['one', 'two', 'three', 'four']) logs.call(event, { pad: 'p'.repeat(150) });

    // maxFiles counts the live file, so 3 means calls.jsonl + calls.1 + calls.2.
    expect(readdirSync(dir).filter((f) => f.startsWith('calls')).sort()).toEqual([
      'calls.1.jsonl',
      'calls.2.jsonl',
      'calls.jsonl',
    ]);
    expect(lines(join(dir, 'calls.jsonl'))[0].event).toBe('four');
    expect(lines(join(dir, 'calls.1.jsonl'))[0].event).toBe('three');
    expect(lines(join(dir, 'calls.2.jsonl'))[0].event).toBe('two');
    // 'one' is gone, which is the point of a bounded log.
  });

  it('writes a record larger than the whole budget instead of rotating an empty file', () => {
    const dir = tempDir('logs');
    const logs = openLogs({ dir, maxBytes: 50, maxFiles: 3 });

    logs.call('huge', { pad: 'q'.repeat(500) });

    expect(lines(join(dir, 'calls.jsonl'))).toHaveLength(1);
    expect(existsSync(join(dir, 'calls.1.jsonl'))).toBe(false);
  });
});

describe('a channel that cannot be written to', () => {
  it('reports the failure once and then stays quiet, without throwing', () => {
    const dir = tempDir('logs');
    const logs = openLogs({ dir, maxBytes: 1_000_000, maxFiles: 3 });
    const reported = vi.spyOn(console, 'error').mockImplementation(() => {});

    // The directory disappears under the bridge — a full disk or a revoked mount would
    // look the same from here.
    rmSync(dir, { recursive: true, force: true });

    expect(() => logs.call('lost', {})).not.toThrow();
    expect(() => logs.call('also lost', {})).not.toThrow();

    // Logging must never take the bridge down, and must not shout on every record.
    expect(reported).toHaveBeenCalledTimes(1);
  });

  it('leaves the other channel working', () => {
    const dir = tempDir('logs');
    const logs = openLogs({ dir, maxBytes: 1_000_000, maxFiles: 3 });
    const callsFile = join(dir, 'calls.jsonl');

    rmSync(callsFile);
    mkdirSync(callsFile); // a directory where the file was: appendFileSync will refuse
    logs.call('doomed', {});
    logs.work('fine', {});

    expect(lines(join(dir, 'work.jsonl')).map((r) => r.event)).toEqual(['fine']);
  });
});

describe('silentLogs', () => {
  it('discards everything and names no directory', () => {
    expect(() => {
      silentLogs.call('handshake', { backend: 'codex' });
      silentLogs.work('permission', {});
    }).not.toThrow();
    expect(silentLogs.dir).toBe('');
  });
});
