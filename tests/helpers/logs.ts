import type { Fields, Logs } from '../../src/acp/log.ts';

export interface Recorded {
  event: string;
  fields: Fields;
}

/**
 * A `Logs` that keeps everything in memory.
 *
 * Half of what this repository asserts about is a log record — a permission decision,
 * a token budget, the phase a cancel arrived in — so the recorder is a first-class
 * fixture rather than a way to keep the console quiet.
 */
export interface RecordingLogs extends Logs {
  readonly calls: Recorded[];
  readonly works: Recorded[];
  /** Fields of the last record with that event name, on either channel. */
  last(event: string): Fields | undefined;
  /** Event names in the order they were written, for asserting on a sequence. */
  names(channel: 'call' | 'work'): string[];
}

export const recordingLogs = (): RecordingLogs => {
  const calls: Recorded[] = [];
  const works: Recorded[] = [];
  return {
    calls,
    works,
    dir: '(memory)',
    call: (event, fields = {}) => void calls.push({ event, fields }),
    work: (event, fields = {}) => void works.push({ event, fields }),
    last: (event) => [...calls, ...works].reverse().find((r) => r.event === event)?.fields,
    names: (channel) => (channel === 'call' ? calls : works).map((r) => r.event),
  };
};
