/**
 * Keeps a long tool call alive — without also keeping a dead one alive.
 *
 * A client aborts a tool call that goes quiet: for an HTTP MCP server the window is
 * five minutes, and a progress notification resets it. An agent that thinks for six
 * minutes without saying anything would therefore lose a call that was going fine,
 * so something has to tick.
 *
 * The trap is that a tick on a plain timer removes the only way anyone notices a hang.
 * The idle window is the failure detector; replace it with an unconditional heartbeat
 * and a wedged agent holds the call until the wall-clock limit instead, which defaults
 * to roughly 28 hours. So the tick here is derived from liveness: it keeps going while
 * the upstream is producing events, and gives up on its own once the upstream has been
 * silent for longer than we are willing to wait. Detection moves from the client into
 * the bridge, which is the only place that can tell the difference between a slow agent
 * and an absent one.
 *
 * PROTOCOL RULE: `progress` must strictly increase across the notifications of one
 * request, so it counts notifications rather than reporting elapsed time or a percentage
 * of work nobody can estimate.
 */

export interface HeartbeatOptions {
  /** How long the upstream may be quiet before we send a tick of our own. */
  everyMs: number;
  /** How long the upstream may be quiet before we stop believing in it. */
  silenceLimitMs: number;
  /** Fire-and-forget: a failed notification must not fail the turn. */
  send: (progress: number, message: string) => void;
  /** Called once, when the silence limit is passed. */
  onSilence: (silentMs: number) => void;
}

export class Heartbeat {
  private counter = 0;
  private lastEventAt = Date.now();
  private lastSentAt = 0;
  private lastMessage = 'working';
  private timer: NodeJS.Timeout | null = null;
  private done = false;

  constructor(private readonly opts: HeartbeatOptions) {}

  start(): void {
    if (this.timer || this.done) return;
    this.timer = setInterval(() => this.tick(), Math.max(250, this.opts.everyMs));
    // The bridge should never stay up merely because a heartbeat is pending.
    this.timer.unref();
  }

  /** A real event arrived: it is both the progress worth reporting and proof of life. */
  touch(message: string): void {
    if (this.done) return;
    this.lastEventAt = Date.now();
    this.lastMessage = message || this.lastMessage;
    this.emit(this.lastMessage);
  }

  stop(): void {
    this.done = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private tick(): void {
    if (this.done) return;
    const now = Date.now();
    const silentFor = now - this.lastEventAt;

    if (silentFor >= this.opts.silenceLimitMs) {
      this.stop();
      this.opts.onSilence(silentFor);
      return;
    }
    // A real event may have just reported progress; no need to repeat ourselves.
    if (now - this.lastSentAt < this.opts.everyMs) return;
    this.emit(`${this.lastMessage} — still working, ${Math.round(silentFor / 1000)}s since the last update`);
  }

  private emit(message: string): void {
    this.counter += 1;
    this.lastSentAt = Date.now();
    this.opts.send(this.counter, message);
  }
}
