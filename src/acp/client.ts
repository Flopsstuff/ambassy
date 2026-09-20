/**
 * The ACP half of the bridge: one adapter subprocess per A2A conversation.
 *
 * ACP is the mirror image of A2A. There the agent is a child process spoken to over
 * stdin/stdout in newline-delimited JSON-RPC, and *we* are the client — the role an
 * editor plays. This file owns that side: spawning adapters, opening sessions,
 * keeping one turn in flight at a time, and reaping processes that went quiet.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync, mkdirSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Readable, Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import * as acp from '@agentclientprotocol/sdk';
import type { ActiveSession, ClientConnection, InitializeResponse } from '@agentclientprotocol/sdk';
import {
  decidePermission,
  readTextFileInsideRoot,
  writeTextFileInsideRoot,
  type Boundary,
} from './permissions.ts';

export type BackendId = 'claude' | 'codex';

export interface Backend {
  id: BackendId;
  bin: string;
  label: string;
  /**
   * The mode in which the adapter asks *us* before acting.
   *
   * Set explicitly rather than left alone, because the defaults route the decision
   * somewhere other than this bridge — and both were caught doing it:
   *
   * - Claude inherits the human's own `permissions.defaultMode`. Where that says `auto`,
   *   the adapter approves its own tool calls and not one request arrives here.
   * - Codex's `agent` mode carries `approvalsReviewer: "auto_review"`, an automatic
   *   reviewer that answers on the client's behalf. Under it Codex overwrote a file two
   *   directories above its own root without asking. `read-only` is the mode whose
   *   reviewer is `user`; the name is about approvals, not about writing — inside the
   *   workspace it still edits freely.
   *
   * The two vocabularies do not overlap, hence one id per backend.
   */
  supervisedModeId: string;
}

export const BACKENDS: Record<BackendId, Backend> = {
  claude: { id: 'claude', bin: 'claude-agent-acp', label: 'Claude', supervisedModeId: 'default' },
  codex: { id: 'codex', bin: 'codex-acp', label: 'Codex', supervisedModeId: 'read-only' },
};

// Resolved against this file, not the process cwd: the adapters are spawned with the
// session root as their cwd, so a relative lookup would go hunting in the sandbox.
const BIN_DIR = fileURLToPath(new URL('../../node_modules/.bin/', import.meta.url));

/** Where per-conversation sandboxes are made when ACP_CWD is empty. Gitignored. */
const SANDBOX_DIR = fileURLToPath(new URL('../../.acp-sandboxes/', import.meta.url));

export interface RegistryOptions {
  backend: Backend;
  /** ACP_CWD, if set. Empty means "make a sandbox per conversation". */
  cwdOverride: string;
  allowExecute: boolean;
  idleTimeoutMs: number;
}

const CLIENT_NAME = 'rob-a2a-bridge';

/** What we tell the adapter we can do. Declaring fs routes file access through us. */
const CLIENT_CAPABILITIES = {
  fs: { readTextFile: true, writeTextFile: true },
  terminal: false,
};

interface Connected {
  child: ChildProcessWithoutNullStreams;
  conn: ClientConnection;
}

/** What the permission and fs handlers need to know, resolved per call. */
interface Supervisor {
  boundary: () => Boundary;
  noteDenial: (summary: string) => void;
}

const connect = (backend: Backend, cwd: string, supervisor: Supervisor): Connected => {
  const child = spawn(join(BIN_DIR, backend.bin), [], { cwd, stdio: ['pipe', 'pipe', 'inherit'] });
  child.on('error', (err) => console.error(`  ⨯ ${backend.bin} failed to start:`, err));

  // ndJsonStream takes (writable, readable) — outgoing first. Getting the order wrong
  // produces a connection that hangs rather than an error.
  const stream = acp.ndJsonStream(
    Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
    Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
  );

  const conn = acp
    .client({ name: CLIENT_NAME })
    .onRequest(acp.methods.client.session.requestPermission, (c) =>
      decidePermission(c.params, supervisor.boundary(), supervisor.noteDenial),
    )
    .onRequest(acp.methods.client.fs.readTextFile, (c) => readTextFileInsideRoot(c.params, supervisor.boundary()))
    .onRequest(acp.methods.client.fs.writeTextFile, (c) => writeTextFileInsideRoot(c.params, supervisor.boundary()))
    .connect(stream);

  return { child, conn };
};

/** Both adapters exit on stdin EOF, so closing the pipe is the polite way out. */
const stop = async (child: ChildProcessWithoutNullStreams): Promise<void> => {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((done) => child.once('exit', () => done()));
  child.stdin.end();
  const executioner = setTimeout(() => child.kill('SIGKILL'), 3000);
  executioner.unref();
  await exited;
  clearTimeout(executioner);
};

class Runtime {
  readonly openTasks = new Set<string>();
  private queue: Promise<unknown> = Promise.resolve();
  private inFlight = 0;
  private lastUsedAt = Date.now();

  constructor(
    readonly contextId: string,
    readonly boundary: Boundary,
    private readonly child: ChildProcessWithoutNullStreams,
    private readonly conn: ClientConnection,
    readonly session: ActiveSession,
    /** The very array the permission handler appends to — shared, not copied. */
    private readonly denials: string[],
  ) {}

  get sessionId(): string {
    return this.session.sessionId;
  }

  /** One turn at a time: two prompts in one session would interleave in the update queue. */
  run<T>(fn: () => Promise<T>): Promise<T> {
    this.inFlight += 1;
    const next = this.queue.then(fn, fn);
    this.queue = next.then(
      () => undefined,
      () => undefined,
    );
    return next.finally(() => {
      this.inFlight -= 1;
      this.lastUsedAt = Date.now();
    });
  }

  /** Policy refusals recorded since the last call, so a turn can explain why it ended. */
  takeDenials(): string[] {
    return this.denials.splice(0);
  }

  async notifyCancel(): Promise<void> {
    await this.conn.agent.notify(acp.methods.agent.session.cancel, { sessionId: this.sessionId });
  }

  idleFor(now: number): number {
    return this.inFlight > 0 || this.openTasks.size > 0 ? 0 : now - this.lastUsedAt;
  }

  get alive(): boolean {
    return this.child.exitCode === null && this.child.signalCode === null;
  }

  onExit(handler: () => void): void {
    this.child.once('exit', handler);
  }

  async dispose(): Promise<void> {
    this.session.dispose();
    this.conn.close();
    await stop(this.child);
  }
}

export type AcpRuntime = Runtime;

export class AcpRegistry {
  private readonly runtimes = new Map<string, Runtime>();
  private reaper?: NodeJS.Timeout;

  constructor(private readonly opts: RegistryOptions) {}

  /**
   * Start an adapter, read who it says it is, shut it down again.
   *
   * Two things for the price of one: the A2A card gets built from the downstream
   * agent's own self-description instead of a guess, and a backend that cannot start
   * takes the server down at boot rather than on the first request.
   */
  async handshake(): Promise<InitializeResponse> {
    const boundary: Boundary = { root: process.cwd(), owned: false, allowExecute: false };
    const { child, conn } = connect(this.opts.backend, process.cwd(), {
      boundary: () => boundary,
      noteDenial: () => {},
    });
    try {
      return await conn.agent.request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: CLIENT_CAPABILITIES,
        clientInfo: { name: CLIENT_NAME, version: '0.1.0' },
      });
    } finally {
      conn.close();
      await stop(child);
    }
  }

  private boundaryFor(contextId: string): Boundary {
    const { cwdOverride, allowExecute } = this.opts;
    if (cwdOverride) {
      const root = resolve(cwdOverride);
      // Claude validates cwd on session/new — absolute, exists, is a directory — so a
      // bad ACP_CWD is worth catching here, where the message can say what to fix.
      if (!existsSync(root)) throw new Error(`ACP_CWD points at a path that does not exist: ${root}`);
      return { root: realpathSync(root), owned: false, allowExecute };
    }
    // Deliberately NOT under os.tmpdir(). Codex's sandbox counts /tmp and $TMPDIR as
    // writable and asks no one before writing there, so sandboxes placed in the temp tree
    // would be mutually reachable without a single permission request. Here each one sits
    // in its own directory whose only writable neighbour is itself.
    const root = join(SANDBOX_DIR, contextId.slice(0, 8));
    mkdirSync(root, { recursive: true });
    // Resolved once, here: a path that reaches the agent through a symlink comes back
    // resolved, and a textual comparison would then deny the agent its own root.
    return { root: realpathSync(root), owned: true, allowExecute };
  }

  /** The runtime for a conversation, created on first use. */
  async acquire(contextId: string): Promise<Runtime> {
    const existing = this.runtimes.get(contextId);
    if (existing?.alive) return existing;
    if (existing) this.runtimes.delete(contextId);

    const boundary = this.boundaryFor(contextId);
    console.log(`  ⚙ ${contextId.slice(0, 8)}: starting ${this.opts.backend.bin} in ${boundary.root}`);

    const denials: string[] = [];
    const { child, conn } = connect(this.opts.backend, boundary.root, {
      boundary: () => boundary,
      noteDenial: (summary) => denials.push(summary),
    });
    await conn.agent.request(acp.methods.agent.initialize, {
      protocolVersion: acp.PROTOCOL_VERSION,
      clientCapabilities: CLIENT_CAPABILITIES,
      clientInfo: { name: CLIENT_NAME, version: '0.1.0' },
    });

    // `mcpServers` must be present even when empty — its absence is a hard error,
    // while an empty array is fine.
    const session = await conn.agent.buildSession({ cwd: boundary.root, mcpServers: [] }).start();
    await this.superviseMode(conn, session, contextId);

    const runtime = new Runtime(contextId, boundary, child, conn, session, denials);
    runtime.onExit(() => {
      if (this.runtimes.get(contextId) === runtime) this.runtimes.delete(contextId);
      console.log(`  ⨯ ${contextId.slice(0, 8)}: adapter exited`);
    });
    this.runtimes.set(contextId, runtime);
    console.log(`  ⚙ ${contextId.slice(0, 8)}: session ${session.sessionId.slice(0, 8)} ready`);
    return runtime;
  }

  /** Put the session into the mode where the adapter asks us before it acts. */
  private async superviseMode(conn: ClientConnection, session: ActiveSession, contextId: string): Promise<void> {
    const wanted = this.opts.backend.supervisedModeId;
    const state = session.modes;
    const available = state?.availableModes.map((m) => m.id) ?? [];

    if (!state || !available.includes(wanted)) {
      console.log(`  ⚙ ${contextId.slice(0, 8)}: mode '${wanted}' not offered (have: ${available.join(', ') || 'none'})`);
      return;
    }
    if (state.currentModeId === wanted) return;

    await conn.agent.request(acp.methods.agent.session.setMode, { sessionId: session.sessionId, modeId: wanted });
    console.log(`  ⚙ ${contextId.slice(0, 8)}: mode ${state.currentModeId} → ${wanted}`);
  }

  get size(): number {
    return this.runtimes.size;
  }

  /**
   * Reap conversations that went quiet. A task sitting in INPUT_REQUIRED keeps its
   * runtime registered, so the follow-up turn cannot land in a fresh session that has
   * forgotten the first one.
   */
  startReaper(): void {
    this.reaper = setInterval(() => {
      const now = Date.now();
      for (const [contextId, runtime] of this.runtimes) {
        if (runtime.idleFor(now) <= this.opts.idleTimeoutMs) continue;
        console.log(`  ⚙ ${contextId.slice(0, 8)}: idle, stopping adapter`);
        this.runtimes.delete(contextId);
        void runtime.dispose();
      }
    }, 60_000);
    this.reaper.unref();
  }

  async disposeAll(): Promise<void> {
    clearInterval(this.reaper);
    const all = [...this.runtimes.values()];
    this.runtimes.clear();
    await Promise.all(all.map((r) => r.dispose()));
  }
}
