/**
 * Two log files for the bridge, written as JSON Lines and rotated by size.
 *
 * Written by hand rather than pulled from a logging library, for the same reason
 * `proxy.ts` is: the interesting part is small and worth reading. What it needs to do is
 * append a line, count bytes, and rename files — a dependency would hide that behind
 * transports and levels without making it any more correct here.
 *
 * JSON Lines rather than prose, because half of what is logged is structured: token
 * counts, tool-call records, the paths a permission decision turned on. Prose would force
 * whoever reads it later to parse English back into numbers.
 *
 * - `calls.jsonl` — the outward boundary: adapters starting, `initialize`, sessions,
 *   prompts and how they ended, and the token budget they cost.
 * - `work.jsonl` — what the agent did inside a turn: tool calls, their outcomes,
 *   permission decisions, file reads and writes.
 *
 * Logging must never take the bridge down with it, so a failed write is reported once to
 * stderr and then swallowed.
 */
import { appendFileSync, existsSync, mkdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export type Fields = Record<string, unknown>;

export interface LogOptions {
  dir: string;
  maxBytes: number;
  /** Total files kept per channel, the live one included. */
  maxFiles: number;
}

export interface Logs {
  /** Outward calls: initialize, sessions, prompts, results, token budget. */
  call(event: string, fields?: Fields): void;
  /** Inward work: tool calls, permissions, file access. */
  work(event: string, fields?: Fields): void;
  readonly dir: string;
}

class Channel {
  private size: number;
  private broken = false;

  constructor(
    private readonly path: string,
    private readonly maxBytes: number,
    private readonly maxFiles: number,
  ) {
    // Created empty right away rather than on the first record: a channel that exists
    // only once something interesting happened makes every reader special-case its
    // absence, and `work.jsonl` stays empty through an entire run of pure conversation.
    if (!existsSync(path)) writeFileSync(path, '');
    this.size = statSync(path).size;
  }

  write(record: Fields): void {
    if (this.broken) return;
    const line = `${JSON.stringify(record)}\n`;
    const bytes = Buffer.byteLength(line);
    try {
      // Rotate before writing, never after: a record that straddles two files is a record
      // no reader can parse.
      if (this.size > 0 && this.size + bytes > this.maxBytes) this.rotate();
      appendFileSync(this.path, line);
      this.size += bytes;
    } catch (err) {
      this.broken = true;
      console.error(`  ⨯ logging to ${this.path} stopped: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** `calls.jsonl` → `calls.1.jsonl` → … → `calls.<maxFiles-1>.jsonl`, oldest dropped. */
  private numbered(index: number): string {
    return this.path.replace(/\.jsonl$/, `.${index}.jsonl`);
  }

  private rotate(): void {
    rmSync(this.numbered(this.maxFiles - 1), { force: true });
    for (let i = this.maxFiles - 2; i >= 1; i -= 1) {
      const from = this.numbered(i);
      if (existsSync(from)) renameSync(from, this.numbered(i + 1));
    }
    if (existsSync(this.path)) renameSync(this.path, this.numbered(1));
    this.size = 0;
  }
}

export const openLogs = (opts: LogOptions): Logs => {
  mkdirSync(opts.dir, { recursive: true });
  const calls = new Channel(join(opts.dir, 'calls.jsonl'), opts.maxBytes, opts.maxFiles);
  const work = new Channel(join(opts.dir, 'work.jsonl'), opts.maxBytes, opts.maxFiles);
  const stamp = (event: string, fields: Fields): Fields => ({
    ts: new Date().toISOString(),
    event,
    ...fields,
  });

  return {
    call: (event, fields = {}) => calls.write(stamp(event, fields)),
    work: (event, fields = {}) => work.write(stamp(event, fields)),
    dir: opts.dir,
  };
};

/** A logger that discards everything — used by the startup handshake, before logs exist. */
export const silentLogs: Logs = { call: () => {}, work: () => {}, dir: '' };
