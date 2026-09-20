/**
 * The ACP half of the bridge: one adapter subprocess per A2A conversation.
 *
 * ACP is the mirror image of A2A. There the agent is a child process spoken to over
 * stdin/stdout in newline-delimited JSON-RPC, and *we* are the client — the role an
 * editor plays. This file owns that side: spawning adapters, opening sessions,
 * keeping one turn in flight at a time, and reaping processes that went quiet.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, realpathSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Readable, Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import * as acp from '@agentclientprotocol/sdk';
import type { ActiveSession, ClientConnection, InitializeResponse, Usage } from '@agentclientprotocol/sdk';
import type { Logs } from './log.ts';
import {
  decidePermission,
  insideRoot,
  readTextFileInsideRoot,
  writeTextFileInsideRoot,
  type Boundary,
  type Supervision,
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

/**
 * A context id reduced to something readable in a directory listing.
 *
 * Only a label. It names a sandbox for a human reading `.acp-sandboxes/`; it never decides
 * which directory a conversation gets, because the id is text the caller chose.
 */
const label = (contextId: string): string => contextId.replace(/[^a-zA-Z0-9]/g, '').slice(0, 8) || 'ctx';

/** True when `target` is a real directory — not a symlink to one — inside `parent`. */
const ownDirectory = (parent: string, target: string): boolean => {
  if (target === parent || !insideRoot(parent, target)) return false;
  try {
    return lstatSync(target).isDirectory();
  } catch {
    return false;
  }
};

export interface RegistryOptions {
  backend: Backend;
  /** ACP_CWD, if set. Empty means "make a sandbox per conversation". */
  cwdOverride: string;
  allowExecute: boolean;
  idleTimeoutMs: number;
  logs: Logs;
}

const CLIENT_NAME = 'ambassy-bridge';

/** What we tell the adapter we can do. Declaring fs routes file access through us. */
const CLIENT_CAPABILITIES = {
  fs: { readTextFile: true, writeTextFile: true },
  terminal: false,
};

interface Connected {
  child: ChildProcessWithoutNullStreams;
  conn: ClientConnection;
}

/**
 * Per-conversation state the permission handlers read while a turn is running.
 *
 * `taskId` is what lets a permission decision in work.jsonl be matched to the task that
 * provoked it. It is safe to keep one per conversation rather than one per call because
 * `Runtime.run` allows only one turn at a time.
 */
interface TurnState {
  taskId?: string;
  denials: string[];
}

/** Running token cost of a conversation, turn by turn. */
export interface Budget {
  turns: number;
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  cachedReadTokens: number;
  cachedWriteTokens: number;
}

const connect = (backend: Backend, cwd: string, supervise: () => Supervision): Connected => {
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
    .onRequest(acp.methods.client.session.requestPermission, (c) => decidePermission(c.params, supervise()))
    .onRequest(acp.methods.client.fs.readTextFile, (c) => readTextFileInsideRoot(c.params, supervise()))
    .onRequest(acp.methods.client.fs.writeTextFile, (c) => writeTextFileInsideRoot(c.params, supervise()))
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
    /** The very object the permission handlers read from — shared, not copied. */
    private readonly state: TurnState,
  ) {}

  private readonly total: Budget = {
    turns: 0,
    totalTokens: 0,
    inputTokens: 0,
    outputTokens: 0,
    cachedReadTokens: 0,
    cachedWriteTokens: 0,
  };

  /** Marks which task the handlers are currently acting for. */
  beginTurn(taskId: string): void {
    this.state.taskId = taskId;
  }

  endTurn(): void {
    this.state.taskId = undefined;
  }

  /** Adds one turn's usage to the conversation's running total. */
  addUsage(usage?: Usage | null): Budget {
    this.total.turns += 1;
    if (usage) {
      this.total.totalTokens += usage.totalTokens ?? 0;
      this.total.inputTokens += usage.inputTokens ?? 0;
      this.total.outputTokens += usage.outputTokens ?? 0;
      this.total.cachedReadTokens += usage.cachedReadTokens ?? 0;
      this.total.cachedWriteTokens += usage.cachedWriteTokens ?? 0;
    }
    return this.budget;
  }

  get budget(): Budget {
    return { ...this.total };
  }

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
    return this.state.denials.splice(0);
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
  /**
   * Which directory belongs to which conversation — kept here rather than computed from
   * the context id, and kept past the adapter's death so a returning conversation finds
   * the files its earlier turns left behind.
   */
  private readonly sandboxes = new Map<string, string>();
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
    const { child, conn } = connect(this.opts.backend, process.cwd(), () => ({ boundary }));
    const started = Date.now();
    try {
      const result = await conn.agent.request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: CLIENT_CAPABILITIES,
        clientInfo: { name: CLIENT_NAME, version: '0.1.0' },
      });
      this.opts.logs.call('handshake', {
        backend: this.opts.backend.id,
        bin: this.opts.backend.bin,
        ms: Date.now() - started,
        protocolVersion: result.protocolVersion,
        agent: result.agentInfo ?? null,
        authMethods: (result.authMethods ?? []).map((m) => m.id),
        capabilities: result.agentCapabilities ?? null,
      });
      return result;
    } catch (err) {
      this.opts.logs.call('handshake.failed', {
        backend: this.opts.backend.id,
        bin: this.opts.backend.bin,
        ms: Date.now() - started,
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    } finally {
      conn.close();
      await stop(child);
    }
  }

  /**
   * The area one conversation is confined to, and how much it is trusted inside it.
   *
   * `owned` is the whole trust model, so it is asserted rather than inferred: it is true
   * only for a directory this registry made by itself, a few lines below.
   */
  private boundaryFor(contextId: string): Boundary {
    const { cwdOverride, allowExecute } = this.opts;
    if (cwdOverride) {
      const root = resolve(cwdOverride);
      // Claude validates cwd on session/new — absolute, exists, is a directory — so a
      // bad ACP_CWD is worth catching here, where the message can say what to fix.
      if (!existsSync(root)) throw new Error(`ACP_CWD points at a path that does not exist: ${root}`);
      if (!statSync(root).isDirectory()) throw new Error(`ACP_CWD is not a directory: ${root}`);
      return { root: realpathSync(root), owned: false, allowExecute };
    }
    return { root: this.sandboxFor(contextId), owned: true, allowExecute };
  }

  /**
   * Allocate — or recover — the disposable directory for one conversation.
   *
   * The directory is never named after the `contextId`. That id arrives from the A2A
   * caller, and `join(SANDBOX_DIR, '..')` is the repository root: the bridge would then
   * mark its own checkout `owned: true`, which is the flag that lets a shell run there.
   * `mkdtemp` sidesteps the whole question — it fails unless the directory is new, so two
   * conversations cannot land in one, and neither an existing directory nor a symlink
   * wearing the right name can be adopted as one the bridge created.
   *
   * Deliberately NOT under os.tmpdir(). Codex's sandbox counts /tmp and $TMPDIR as
   * writable and asks no one before writing there, so sandboxes placed in the temp tree
   * would be mutually reachable without a single permission request. Here each one sits
   * in its own directory whose only writable neighbour is itself.
   */
  private sandboxFor(contextId: string): string {
    mkdirSync(SANDBOX_DIR, { recursive: true });
    // Resolved once, here: a path that reaches the agent through a symlink comes back
    // resolved, and a textual comparison would then deny the agent its own root.
    const parent = realpathSync(SANDBOX_DIR);

    const known = this.sandboxes.get(contextId);
    if (known && ownDirectory(parent, known)) return known;

    const root = realpathSync(mkdtempSync(join(parent, `${label(contextId)}-`)));
    if (!ownDirectory(parent, root)) throw new Error(`sandbox for ${contextId} escaped ${parent}: ${root}`);
    this.sandboxes.set(contextId, root);
    return root;
  }

  /** The runtime for a conversation, created on first use. */
  async acquire(contextId: string): Promise<Runtime> {
    const existing = this.runtimes.get(contextId);
    if (existing?.alive) return existing;
    if (existing) this.runtimes.delete(contextId);

    const { logs, backend } = this.opts;
    const boundary = this.boundaryFor(contextId);
    console.log(`  ⚙ ${contextId.slice(0, 8)}: starting ${backend.bin} in ${boundary.root}`);

    const state: TurnState = { denials: [] };
    const started = Date.now();
    const { child, conn } = connect(backend, boundary.root, () => ({
      boundary,
      onDeny: (summary) => state.denials.push(summary),
      log: (event, fields) => logs.work(event, { contextId, taskId: state.taskId ?? null, ...fields }),
    }));
    logs.call('adapter.spawn', {
      contextId,
      backend: backend.id,
      bin: backend.bin,
      pid: child.pid ?? null,
      cwd: boundary.root,
      ownedRoot: boundary.owned,
    });

    await conn.agent.request(acp.methods.agent.initialize, {
      protocolVersion: acp.PROTOCOL_VERSION,
      clientCapabilities: CLIENT_CAPABILITIES,
      clientInfo: { name: CLIENT_NAME, version: '0.1.0' },
    });

    // `mcpServers` must be present even when empty — its absence is a hard error,
    // while an empty array is fine.
    const session = await conn.agent.buildSession({ cwd: boundary.root, mcpServers: [] }).start();
    const mode = await this.superviseMode(conn, session, contextId);

    logs.call('session.new', {
      contextId,
      sessionId: session.sessionId,
      cwd: boundary.root,
      ms: Date.now() - started,
      mode,
      availableModes: session.modes?.availableModes.map((m) => m.id) ?? [],
    });

    const runtime = new Runtime(contextId, boundary, child, conn, session, state);
    runtime.onExit(() => {
      if (this.runtimes.get(contextId) === runtime) this.runtimes.delete(contextId);
      console.log(`  ⨯ ${contextId.slice(0, 8)}: adapter exited`);
      logs.call('adapter.exit', {
        contextId,
        sessionId: session.sessionId,
        code: child.exitCode,
        signal: child.signalCode,
        budget: runtime.budget,
      });
    });
    this.runtimes.set(contextId, runtime);
    console.log(`  ⚙ ${contextId.slice(0, 8)}: session ${session.sessionId.slice(0, 8)} ready`);
    return runtime;
  }

  /** Put the session into the mode where the adapter asks us before it acts. */
  private async superviseMode(
    conn: ClientConnection,
    session: ActiveSession,
    contextId: string,
  ): Promise<string | null> {
    const wanted = this.opts.backend.supervisedModeId;
    const modes = session.modes;
    const available = modes?.availableModes.map((m) => m.id) ?? [];

    if (!modes || !available.includes(wanted)) {
      console.log(`  ⚙ ${contextId.slice(0, 8)}: mode '${wanted}' not offered (have: ${available.join(', ') || 'none'})`);
      return modes?.currentModeId ?? null;
    }
    if (modes.currentModeId === wanted) return wanted;

    await conn.agent.request(acp.methods.agent.session.setMode, { sessionId: session.sessionId, modeId: wanted });
    console.log(`  ⚙ ${contextId.slice(0, 8)}: mode ${modes.currentModeId} → ${wanted}`);
    return wanted;
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
        this.opts.logs.call('adapter.reap', {
          contextId,
          sessionId: runtime.sessionId,
          idleMs: runtime.idleFor(now),
          budget: runtime.budget,
        });
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
