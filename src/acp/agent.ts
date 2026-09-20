/**
 * A2A server whose executor is a real coding agent instead of a stub.
 *
 * Two protocols meet here. Upstream is A2A: a stateful task, streamed status updates,
 * an artifact at the end. Downstream is ACP: an adapter subprocess that streams message
 * chunks, tool calls and plans. This file is the translation between them — see the
 * switch in `turn()`, which is the whole point of the exercise.
 *
 * The backend is chosen by the launch command: `yarn agent:claude` / `yarn agent:codex`.
 */
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import express from 'express';
import {
  A2A_PROTOCOL_VERSION,
  AGENT_CARD_PATH,
  Role,
  TaskState,
  type AgentCard,
  type Artifact,
  type Message,
  type Part,
  type Task,
  type TaskArtifactUpdateEvent,
  type TaskStatusUpdateEvent,
} from '@a2a-js/sdk';
import {
  AgentEvent,
  DefaultRequestHandler,
  InMemoryTaskStore,
  type AgentExecutor,
  type ExecutionEventBus,
  type RequestContext,
} from '@a2a-js/sdk/server';
import { agentCardHandler, jsonRpcHandler, UserBuilder } from '@a2a-js/sdk/server/express';
import { RequestError, type StopReason, type Usage } from '@agentclientprotocol/sdk';
import { AcpRegistry, BACKENDS, type AcpRuntime, type Backend, type BackendId } from './client.ts';
import { openLogs, type Logs } from './log.ts';

// Node 23 reads .env by itself; a missing file is not an error, the defaults below suffice.
const ENV_FILE = fileURLToPath(new URL('../../.env', import.meta.url));
if (existsSync(ENV_FILE)) process.loadEnvFile(ENV_FILE);

const BACKEND_ID = (process.env.ACP_AGENT ?? '') as BackendId;
if (!BACKENDS[BACKEND_ID]) {
  console.error(`Set ACP_AGENT to one of: ${Object.keys(BACKENDS).join(', ')} — use yarn agent:claude / yarn agent:codex`);
  process.exit(1);
}
const backend: Backend = BACKENDS[BACKEND_ID];

const PORT = Number(process.env.PORT ?? 41241);
// The URL the agent advertises in its card. Override it to route clients through the wire-tap.
const PUBLIC_URL = process.env.PUBLIC_URL ?? `http://localhost:${PORT}/`;
// Empty means a throwaway sandbox per conversation — see acp-client.ts.
const ACP_CWD = process.env.ACP_CWD ?? '';
const ACP_ALLOW_EXECUTE = process.env.ACP_ALLOW_EXECUTE === 'true';
const ACP_IDLE_TIMEOUT_MS = Number(process.env.ACP_IDLE_TIMEOUT_MS ?? 300_000);
const LOG_DIR = process.env.LOG_DIR ?? fileURLToPath(new URL('../../logs/', import.meta.url));
const LOG_MAX_BYTES = Number(process.env.LOG_MAX_BYTES ?? 5_000_000);
const LOG_MAX_FILES = Number(process.env.LOG_MAX_FILES ?? 5);

const logs = openLogs({ dir: LOG_DIR, maxBytes: LOG_MAX_BYTES, maxFiles: LOG_MAX_FILES });

// --- Part/Message helpers: in v1.0 a Part is a discriminated union on `content.$case` ---

const textPart = (value: string): Part => ({
  content: { $case: 'text', value },
  metadata: undefined,
  filename: '',
  mediaType: 'text/plain',
});

const dataPart = (value: unknown): Part => ({
  content: { $case: 'data', value },
  metadata: undefined,
  filename: '',
  mediaType: 'application/json',
});

const agentMessage = (taskId: string, contextId: string, parts: Part[]): Message => ({
  messageId: crypto.randomUUID(),
  contextId,
  taskId,
  role: Role.ROLE_AGENT,
  parts,
  metadata: {},
  extensions: [],
  referenceTaskIds: [],
});

const statusUpdate = (
  taskId: string,
  contextId: string,
  state: TaskState,
  message?: Message,
): TaskStatusUpdateEvent => ({
  taskId,
  contextId,
  status: { state, message, timestamp: new Date().toISOString() },
  metadata: {},
});

const readText = (message: Message): string =>
  message.parts
    .map((p) => (p.content?.$case === 'text' ? p.content.value : ''))
    .join(' ')
    .trim();

// --- translating one protocol into the other ---

interface ToolRecord {
  toolCallId: string;
  title: string;
  kind: string;
  status: string;
}

const describeError = (err: unknown): string => {
  // Both adapters answer -32000 when the underlying CLI is not logged in: Codex refuses
  // at session/new, Claude waits until the prompt.
  if (err instanceof RequestError && err.code === -32000) {
    return `${backend.label} is not authenticated — log in with its own CLI, then restart the bridge`;
  }
  return err instanceof Error ? err.message : String(err);
};

class AcpExecutor implements AgentExecutor {
  private readonly runtimeByTask = new Map<string, AcpRuntime>();
  private readonly cancelled = new Set<string>();

  constructor(
    private readonly registry: AcpRegistry,
    private readonly logs: Logs,
  ) {}

  /**
   * The SDK awaits this, then drains the bus until the task is terminal and insists the
   * stored state is CANCELED — anything else comes back to the caller as
   * `-32002 TASK_NOT_CANCELABLE`. So the flag matters as much as the notification: a
   * cancel can arrive while the adapter is still starting, seconds before there is a
   * session to cancel, and dropping it there is what made this look broken.
   */
  cancelTask = async (taskId: string): Promise<void> => {
    this.cancelled.add(taskId);
    const runtime = this.runtimeByTask.get(taskId);

    if (!runtime) {
      console.log(`  ↯ cancel ${taskId.slice(0, 8)}: no session yet — execute() will stop before prompting`);
      this.logs.call('task.cancel', { taskId, phase: 'no-session' });
      return;
    }

    // In ACP cancelling is a notification, not a request: the turn keeps streaming and
    // ends with stopReason 'cancelled', which `turn()` maps to TASK_STATE_CANCELED.
    console.log(`  ↯ cancel ${taskId.slice(0, 8)}: session/cancel → ${runtime.sessionId.slice(0, 8)}`);
    this.logs.call('task.cancel', { taskId, phase: 'session/cancel', sessionId: runtime.sessionId });
    try {
      await runtime.notifyCancel();
    } catch (err) {
      console.log(`  ↯ cancel ${taskId.slice(0, 8)}: notification failed — ${describeError(err)}`);
    }
  };

  async execute(ctx: RequestContext, bus: ExecutionEventBus): Promise<void> {
    const { taskId, contextId, task: existingTask } = ctx;
    const userMessage = ctx.userMessage;
    const text = readText(userMessage);

    console.log(
      `\n▶ execute: task=${taskId.slice(0, 8)} context=${contextId.slice(0, 8)} ` +
        `${existingTask ? '(resuming task)' : '(new task)'} text=${JSON.stringify(text.slice(0, 40))}`,
    );
    this.logs.call('task.start', {
      taskId,
      contextId,
      resuming: Boolean(existingTask),
      chars: text.length,
    });

    // PROTOCOL RULE: the first event must always be a Task or a Message — otherwise
    // the server rejects the stream.
    const snapshot: Task = existingTask ?? {
      id: taskId,
      contextId,
      status: { state: TaskState.TASK_STATE_SUBMITTED, timestamp: new Date().toISOString(), message: undefined },
      artifacts: [],
      history: [userMessage],
      metadata: userMessage.metadata,
    };
    bus.publish(AgentEvent.task(snapshot));

    let runtime: AcpRuntime | undefined;
    let terminal = false;

    try {
      runtime = await this.registry.acquire(contextId);
      // Registered before the first turn so the reaper cannot take the adapter away
      // while the task is alive. A task parked in INPUT_REQUIRED keeps it, too.
      runtime.openTasks.add(taskId);
      this.runtimeByTask.set(taskId, runtime);

      // No text is not an error but a non-terminal state: the task stays alive, awaiting input.
      if (!text) {
        console.log('  ⤷ nothing to send → INPUT_REQUIRED (task stays open, adapter stays up)');
        this.logs.call('task.input_required', { taskId, contextId, sessionId: runtime.sessionId });
        bus.publish(
          AgentEvent.statusUpdate(
            statusUpdate(
              taskId,
              contextId,
              TaskState.TASK_STATE_INPUT_REQUIRED,
              agentMessage(taskId, contextId, [
                textPart(`Tell me what to do — reply into this same task and ${backend.label} picks it up.`),
              ]),
            ),
          ),
        );
        return;
      }

      // A cancel that landed while the adapter was starting: there was no session to send
      // it to, so it is honoured here instead of being lost.
      if (this.cancelled.has(taskId)) {
        console.log('  ⤷ cancelled before the prompt was sent');
        this.logs.call('task.finish', { taskId, contextId, state: 'CANCELED', phase: 'before-prompt' });
        terminal = true;
        bus.publish(
          AgentEvent.statusUpdate(
            statusUpdate(
              taskId,
              contextId,
              TaskState.TASK_STATE_CANCELED,
              agentMessage(taskId, contextId, [textPart('Cancelled before the request reached the agent.')]),
            ),
          ),
        );
        return;
      }

      const current = runtime;
      terminal = await current.run(() => this.turn(current, taskId, contextId, bus, text));
    } catch (err) {
      terminal = true;
      const reason = describeError(err);
      console.log(`  ⤷ failed: ${reason}`);
      this.logs.call('task.failed', { taskId, contextId, reason });
      bus.publish(
        AgentEvent.statusUpdate(
          statusUpdate(
            taskId,
            contextId,
            TaskState.TASK_STATE_FAILED,
            agentMessage(taskId, contextId, [textPart(reason)]),
          ),
        ),
      );
    } finally {
      this.runtimeByTask.delete(taskId);
      this.cancelled.delete(taskId);
      // Also cleared before settle(); repeated here so a turn that threw does not leave
      // the permission handlers labelling their records with a task that is over.
      runtime?.endTurn();
      if (terminal) runtime?.openTasks.delete(taskId);
    }
  }

  /** One ACP prompt turn, streamed out as A2A status updates. Returns true when terminal. */
  private async turn(
    runtime: AcpRuntime,
    taskId: string,
    contextId: string,
    bus: ExecutionEventBus,
    text: string,
  ): Promise<boolean> {
    const { session } = runtime;
    const chunks: string[] = [];
    const tools: ToolRecord[] = [];
    const startedAt = Date.now();
    runtime.takeDenials(); // drop anything left over from an earlier turn
    // Tells the permission handlers which task they are deciding for, so their records in
    // work.jsonl can be matched to it.
    runtime.beginTurn(taskId);
    this.logs.call('prompt.start', {
      taskId,
      contextId,
      sessionId: runtime.sessionId,
      chars: text.length,
    });

    const logTool = (event: string, fields: Record<string, unknown>): void =>
      this.logs.work(event, { taskId, contextId, sessionId: runtime.sessionId, ...fields });

    const say = (line: string): void => {
      bus.publish(
        AgentEvent.statusUpdate(
          statusUpdate(
            taskId,
            contextId,
            TaskState.TASK_STATE_WORKING,
            agentMessage(taskId, contextId, [textPart(line)]),
          ),
        ),
      );
    };

    // Codex streams one token per update, Claude whole paragraphs. Forwarded verbatim,
    // the first buries the wire under hundreds of single-word SSE frames while the second
    // reads fine — so text is coalesced here and both end up looking the same.
    let channel: 'answer' | 'thinking' = 'answer';
    let pending = '';

    const flush = (): void => {
      const out = pending.trim();
      pending = '';
      if (out) say(channel === 'thinking' ? `thinking: ${out}` : out);
    };

    const push = (next: 'answer' | 'thinking', piece: string): void => {
      if (next !== channel) {
        flush();
        channel = next;
      }
      if (next === 'answer') chunks.push(piece);
      pending += piece;
      if (pending.length >= 160 || pending.includes('\n')) flush();
    };

    const finish = (state: TaskState, line?: string): true => {
      bus.publish(
        AgentEvent.statusUpdate(
          statusUpdate(
            taskId,
            contextId,
            state,
            line ? agentMessage(taskId, contextId, [textPart(line)]) : undefined,
          ),
        ),
      );
      return true;
    };

    // The prompt is deliberately not awaited: updates land on the session queue while it
    // runs, and the same completion arrives there as a `stop` message. Its promise is
    // reshaped so the loop can race it — never settling on success, rejecting on failure.
    const prompt = session.prompt(text);
    const failure = prompt.then(
      () => new Promise<never>(() => {}),
      (err) => Promise.reject(err),
    );

    for (;;) {
      const message = await Promise.race([session.nextUpdate(), failure]);

      if (message.kind === 'stop') {
        flush();
        runtime.endTurn();
        return this.settle(
          startedAt,message.stopReason, message.response.usage, runtime, chunks, tools, taskId, contextId, bus, finish);
      }

      const update = message.update;
      switch (update.sessionUpdate) {
        case 'agent_message_chunk': {
          push('answer', update.content.type === 'text' ? update.content.text : `<${update.content.type}>`);
          break;
        }

        case 'agent_thought_chunk': {
          if (update.content.type === 'text') push('thinking', update.content.text);
          break;
        }

        case 'tool_call': {
          flush();
          const record: ToolRecord = {
            toolCallId: update.toolCallId,
            title: update.title,
            kind: update.kind ?? 'other',
            status: update.status ?? 'pending',
          };
          tools.push(record);
          console.log(`  ⤷ tool «${record.title}» (${record.kind}, ${record.status})`);
          logTool('tool.call', {
            toolCallId: record.toolCallId,
            title: record.title,
            kind: record.kind,
            status: record.status,
            locations: (update.locations ?? []).map((l) => l.path),
          });
          say(`«${record.title}» (${record.kind}, ${record.status})`);
          break;
        }

        case 'tool_call_update': {
          // Only the status transition is worth a frame; everything else is noise.
          flush();
          const record = tools.find((t) => t.toolCallId === update.toolCallId);
          const next = update.status ?? undefined;
          if (next && record && next !== record.status) {
            record.status = next;
            console.log(`  ⤷ tool «${record.title}» → ${next}`);
            logTool('tool.update', { toolCallId: record.toolCallId, title: record.title, status: next });
            say(`«${record.title}» → ${next}`);
          }
          break;
        }

        case 'plan': {
          flush();
          logTool('plan', {
            entries: update.entries.map((e) => ({ status: e.status, content: e.content })),
          });
          const entries = update.entries.map((e) => `· [${e.status}] ${e.content}`).join('\n');
          say(`plan:\n${entries}`);
          break;
        }

        default:
          // Vendor tags and updates we do not surface. The union is closed in TypeScript
          // but agents are allowed to invent their own, so this branch must exist.
          break;
      }
    }
  }

  private settle(
    startedAt: number,
    stopReason: StopReason,
    usage: Usage | null | undefined,
    runtime: AcpRuntime,
    chunks: string[],
    tools: ToolRecord[],
    taskId: string,
    contextId: string,
    bus: ExecutionEventBus,
    finish: (state: TaskState, line?: string) => true,
  ): true {
    const answer = chunks.join('').trim();
    const failedTools = tools.filter((t) => t.status === 'failed');
    const denials = runtime.takeDenials();
    const cancelRequested = this.cancelled.has(taskId);
    const budget = runtime.addUsage(usage);

    // The token budget lives here rather than in the artifact alone: a conversation is
    // several turns, and only the running total says what it cost.
    this.logs.call('prompt.stop', {
      taskId,
      contextId,
      sessionId: runtime.sessionId,
      ms: Date.now() - startedAt,
      stopReason,
      cancelRequested,
      answerChars: answer.length,
      toolCalls: tools.length,
      failedToolCalls: failedTools.length,
      refusals: denials,
      usage: usage ?? null,
      budget,
    });

    const done = (state: TaskState, line?: string): true => {
      this.logs.call('task.finish', { taskId, contextId, state: TaskState[state], stopReason, budget });
      return finish(state, line);
    };

    if (stopReason === 'cancelled') {
      // Two different things end a turn this way: an A2A CancelTask, or our own classifier
      // refusing an action on a backend that offers no gentler refusal than aborting the
      // turn. Only the log distinguishes them unless the reason travels with the status.
      console.log(`  ⤷ cancelled${denials.length ? ` after ${denials.length} refusal(s)` : ''}`);
      return done(
        TaskState.TASK_STATE_CANCELED,
        denials.length ? `Refused by the bridge: ${denials.join('; ')}` : undefined,
      );
    }

    if (stopReason === 'refusal') {
      console.log('  ⤷ refused');
      return done(TaskState.TASK_STATE_FAILED, answer || `${backend.label} refused the request.`);
    }

    const summary = {
      backend: backend.id,
      sessionId: runtime.sessionId,
      root: runtime.boundary.root,
      stopReason,
      toolCalls: tools,
      failedToolCalls: failedTools.length,
      refusedByBridge: denials,
      usage: usage ?? null,
    };

    const artifact: Artifact = {
      artifactId: crypto.randomUUID(),
      name: 'acp-answer',
      description: `Answer produced by ${backend.label} over ACP`,
      parts: [
        textPart(answer || '(the agent finished the turn without saying anything)'),
        dataPart(summary), // structured part: a machine reads this instead of parsing the string
      ],
      metadata: undefined,
      extensions: [],
    };

    const artifactEvent: TaskArtifactUpdateEvent = {
      taskId,
      contextId,
      artifact,
      lastChunk: true,
      append: false,
      metadata: undefined,
    };
    bus.publish(AgentEvent.artifactUpdate(artifactEvent));

    // The turn ran to its end, but a cancel was asked for and acted on while it was still
    // running — the SDK only clears CancelTask if the stored state ends up CANCELED, and
    // the caller is owed that answer. The artifact goes out first, so the work that did
    // happen is not thrown away with the status.
    if (cancelRequested) {
      console.log('  ⤷ cancelled, though the agent had already finished the turn');
      return done(
        TaskState.TASK_STATE_CANCELED,
        'Cancelled. The agent had already finished this turn — its answer is in the artifact.',
      );
    }

    // `max_tokens` and `max_turn_requests` are ceilings, not errors — the turn did end,
    // so the task completes and the reason travels in the data part. Only Claude sends
    // them; Codex reports nothing but end_turn and cancelled, which is why a failed tool
    // call is counted separately above.
    const trouble = [
      denials.length ? `${denials.length} action(s) refused by the bridge` : '',
      failedTools.length ? `${failedTools.length} tool call(s) failed` : '',
    ].filter(Boolean);
    const note =
      stopReason === 'end_turn'
        ? trouble.length
          ? `Done, but ${trouble.join(' and ')}.`
          : undefined
        : `Stopped early: ${stopReason}.`;

    console.log(`  ⤷ completed (${stopReason}), artifact delivered, ${tools.length} tool call(s)`);
    return done(TaskState.TASK_STATE_COMPLETED, note);
  }
}

// --- Agent Card: built from the adapter's own answer to `initialize` ---

const registry = new AcpRegistry({
  backend,
  cwdOverride: ACP_CWD,
  allowExecute: ACP_ALLOW_EXECUTE,
  idleTimeoutMs: ACP_IDLE_TIMEOUT_MS,
  logs,
});

console.log(`Probing ${backend.bin}…`);
const handshake = await registry.handshake();
const downstream = handshake.agentInfo;
console.log(
  `  ⚙ ${downstream?.title ?? backend.label} ${downstream?.version ?? ''} ` +
    `(ACP protocol ${handshake.protocolVersion}), auth methods: ${handshake.authMethods?.length ?? 0}`,
);

const agentCard: AgentCard = {
  name: `${backend.label} (via ACP)`,
  description: `An A2A front for ${downstream?.name ?? backend.bin}: the task is forwarded to a real coding agent over ACP.`,
  supportedInterfaces: [
    {
      url: PUBLIC_URL,
      protocolBinding: 'JSONRPC',
      tenant: '',
      protocolVersion: A2A_PROTOCOL_VERSION,
    },
  ],
  provider: { organization: 'Flopsstuff', url: 'https://example.local' },
  version: downstream?.version ?? '0.1.0',
  capabilities: {
    streaming: true,
    pushNotifications: false,
    extensions: [],
    extendedAgentCard: false,
  },
  securitySchemes: {},
  securityRequirements: [],
  defaultInputModes: ['text'],
  defaultOutputModes: ['text', 'data'],
  skills: [
    {
      id: 'acp_prompt',
      name: 'Coding agent',
      description: `Forwards the request to ${downstream?.title ?? backend.label} and streams back its progress and answer.`,
      tags: ['code', 'acp', backend.id],
      examples: ['Create hello.txt with a greeting', 'Explain what this directory contains'],
      inputModes: ['text'],
      outputModes: ['text', 'data'],
      securityRequirements: [],
    },
  ],
  documentationUrl: '',
  signatures: [],
};

const requestHandler = new DefaultRequestHandler(agentCard, new InMemoryTaskStore(), new AcpExecutor(registry, logs));

const app = express();
app.use((req, _res, next) => {
  console.log(`  ← ${req.method} ${req.originalUrl}`);
  next();
});
app.use(`/${AGENT_CARD_PATH}`, agentCardHandler({ agentCardProvider: requestHandler }));
app.use(jsonRpcHandler({ requestHandler, userBuilder: UserBuilder.noAuthentication }));

registry.startReaper();

app.listen(PORT, () => {
  console.log(`${agentCard.name} listening on http://localhost:${PORT}`);
  console.log(`Agent Card:          http://localhost:${PORT}/${AGENT_CARD_PATH}`);
  console.log(`Session root:        ${ACP_CWD || 'a fresh sandbox per conversation'}`);
  console.log(`Logs:                ${logs.dir} (calls.jsonl, work.jsonl)`);
});

const shutdown = async (signal: string): Promise<void> => {
  console.log(`\n${signal}: stopping ${registry.size} adapter(s)…`);
  await registry.disposeAll();
  process.exit(0);
};
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
