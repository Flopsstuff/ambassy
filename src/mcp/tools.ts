/**
 * The four tools the bridge publishes.
 *
 * Generic rather than one tool per A2A skill, and that is a decision rather than a
 * shortcut: the agent behind this bridge advertises a single free-text skill, so
 * projecting its `skills[]` would produce exactly one tool taking exactly one string —
 * the same generic tool, with extra machinery. Selecting a skill from the client side
 * is being specified for A2A v1.1; inventing a private dialect of it now would only
 * have to be unpicked later.
 *
 * Results are plain text blocks, including the structured half, which is also a
 * decision. The structured payload is the downstream bridge's envelope — `toolCalls`,
 * `refusedByBridge`, token usage — and declaring an `outputSchema` for it here would
 * freeze someone else's shape into our contract and start failing the moment they add
 * a field. A JSON block reads the same to a model and survives the change.
 *
 * Every result that can be recovered from says how. A task lives on the agent, not in
 * this bridge, so a call that breaks — a broken stream, a silent upstream, a client that
 * hung up — leaves work running that the caller can still reach, and the only thing
 * standing between them is whether the `taskId` came back.
 */
import { TaskState } from '@a2a-js/sdk';
import type { CallToolResult, McpServer, ServerContext } from '@modelcontextprotocol/server';
import { z } from 'zod';

import type { Logs } from '../acp/log.ts';
import {
  A2APool,
  TurnError,
  UnknownAgentError,
  isInterrupted,
  type AskIdentity,
  type AskResult,
  type FlatArtifact,
  type TaskSnapshot,
} from './a2a.ts';
import { Heartbeat } from './heartbeat.ts';

export interface ToolOptions {
  pool: A2APool;
  logs: Logs;
  heartbeatMs: number;
  silenceLimitMs: number;
}

const text = (value: string): CallToolResult['content'][number] => ({ type: 'text', text: value });

const json = (value: unknown): CallToolResult['content'][number] =>
  text(`\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\``);

const failure = (message: string, envelope?: unknown): CallToolResult => ({
  content: envelope === undefined ? [text(message)] : [text(message), json(envelope)],
  isError: true,
});

// --- recovery ---

/**
 * What to do next when a call did not deliver its answer.
 *
 * Without this the advertised recovery path is unusable: `a2a_task` needs the real task
 * id, and a caller on its first turn does not even know the context it was given.
 */
const recovery = (id: AskIdentity): string => {
  const agent = id.agent ? `, "agent": "${id.agent}"` : '';
  if (!id.taskId) {
    return id.contextId
      ? `No task id came back. The conversation is "${id.contextId}" — retry there with a2a_ask.`
      : 'No task id came back, so nothing was accepted on the agent: retry with a2a_ask.';
  }
  return (
    `The task is still on the agent and unaffected by this call ending. Read it with ` +
    `a2a_task { "taskId": "${id.taskId}"${agent} }, or stop it with a2a_cancel { "taskId": "${id.taskId}"${agent} }.`
  );
};

const identityOf = (err: unknown, fallback: AskIdentity): AskIdentity =>
  err instanceof TurnError ? err.identity : fallback;

/** An unknown alias is the caller's mistake to correct, not a protocol error to trap. */
const asToolFailure = (err: unknown, identity?: AskIdentity): CallToolResult => {
  if (err instanceof UnknownAgentError) return failure(err.message);
  const reason = `A2A call failed: ${(err as Error).message ?? String(err)}`;
  if (!identity) return failure(reason);
  const id = identityOf(err, identity);
  // The envelope is the handle; without a task id there is no handle, and an envelope of
  // empty strings would only look like one.
  return failure(`${reason}\n\n${recovery(id)}`, id.taskId ? envelopeOf(id) : undefined);
};

// --- rendering what came back ---

const envelopeOf = (id: AskIdentity): Record<string, unknown> => ({
  agent: id.agent,
  taskId: id.taskId,
  contextId: id.contextId,
});

const artifactView = (artifacts: FlatArtifact[]): unknown[] =>
  artifacts.map((a) => ({
    artifactId: a.artifactId,
    name: a.name,
    ...(a.description ? { description: a.description } : {}),
    text: a.text,
    // Kept as sent: these are what a machine reads instead of parsing the prose, and one
    // artifact may carry several of them.
    ...(a.data.length > 0 ? { data: a.data } : {}),
    ...(a.complete ? {} : { complete: false }),
  }));

const askEnvelope = (result: AskResult): Record<string, unknown> => ({
  ...envelopeOf(result),
  state: TaskState[result.state],
  outcome: result.outcome,
  ...(result.status ? { statusMessage: result.status } : {}),
  ...(result.message ? { message: result.message } : {}),
  ...(result.artifacts.length > 0 ? { artifacts: artifactView(result.artifacts) } : {}),
});

/** Everything the agent said, in the order a reader wants it. */
const said = (result: AskResult): string => [result.answer, result.message].filter(Boolean).join('\n\n');

const renderAsk = (result: AskResult): CallToolResult => {
  const envelope = askEnvelope(result);
  const body = said(result);

  // Alive and waiting on the caller. The instruction has to name the task, because
  // answering with the context alone opens a *second* task and leaves this one parked.
  if (result.outcome === 'interrupted') {
    const needed =
      result.state === TaskState.TASK_STATE_AUTH_REQUIRED
        ? 'The agent needs authentication before it can finish.'
        : 'The agent needs more input before it can finish.';
    return {
      content: [
        text(
          `${needed}\n\n${result.status || body || '(it did not say what)'}\n\n` +
            `Answer by calling a2a_ask with taskId "${result.taskId}" and contextId "${result.contextId}" — ` +
            `the task stays open and keeps its history. Omit taskId only to start new work in the same conversation.`,
        ),
        json(envelope),
      ],
    };
  }

  // The stream stopped without an ending: no terminal state, no interruption, no message.
  // Reporting the last state seen would tell the caller the agent "finished in WORKING".
  if (result.outcome === 'truncated') {
    const where = result.taskId
      ? `while the task was ${TaskState[result.state]}`
      : 'before the agent accepted anything';
    return failure(
      `The agent's stream ended ${where}, so this turn has no result.\n\n${recovery(result)}` +
        (body ? `\n\nWhat had arrived before it stopped:\n\n${body}` : ''),
      envelope,
    );
  }

  // A direct Message is a complete answer in A2A: no task is created, so there is nothing
  // to recover and nothing to continue but the conversation.
  if (result.outcome === 'message') {
    return { content: [text(body || '(the agent answered with an empty message)'), json(envelope)] };
  }

  const state = TaskState[result.state];
  const failed = result.state === TaskState.TASK_STATE_FAILED || result.state === TaskState.TASK_STATE_REJECTED;
  const cancelled = result.state === TaskState.TASK_STATE_CANCELED;

  // The reason a task failed or was cancelled arrives in its last status message and
  // nowhere else — the ACP bridge's permission refusals come through exactly this way.
  // Whatever partial output exists is kept: cancelling late does not unmake the work.
  if (failed || cancelled) {
    const lead = failed ? `The task ${state.replace('TASK_STATE_', '').toLowerCase()}` : 'The task was cancelled';
    return failure(
      `${lead}: ${result.status || '(the agent gave no reason)'}` +
        (body ? `\n\nWhat it produced anyway:\n\n${body}` : ''),
      envelope,
    );
  }

  // COMPLETED. The last status message is usually the last progress line, so it is worth
  // repeating only when there is no answer at all — and then it is labelled as what it is,
  // rather than handed over as though the agent had answered with it.
  if (body) return { content: [text(body), json(envelope)] };
  const nothing = `The agent finished in ${state} without producing an answer.`;
  return {
    content: [text(result.status ? `${nothing} Its last status message: ${result.status}` : nothing), json(envelope)],
  };
};

const renderTask = (task: TaskSnapshot): CallToolResult => {
  const state = TaskState[task.state];
  const body = task.artifacts
    .map((a) => a.text)
    .filter(Boolean)
    .join('\n\n');
  const lines = [`Task ${task.taskId} is ${state} in context ${task.contextId}, with ${task.artifacts.length} artifact(s).`];
  if (task.status) lines.push(`Agent's last word: ${task.status}`);
  if (body) lines.push(body);
  if (isInterrupted(task.state)) {
    lines.push(`It is still open — continue it with a2a_ask { "taskId": "${task.taskId}", "contextId": "${task.contextId}", "text": "…" }.`);
  }
  return {
    content: [
      text(lines.join('\n\n')),
      json({
        ...envelopeOf(task),
        state,
        ...(task.status ? { statusMessage: task.status } : {}),
        artifacts: artifactView(task.artifacts),
      }),
    ],
  };
};

// --- registration ---

export const registerTools = (mcp: McpServer, opts: ToolOptions): void => {
  const { pool, logs } = opts;
  const agentArg = z.string().optional().describe(`Agent alias. Configured: ${pool.aliases().join(', ')}`);

  mcp.registerTool(
    'a2a_ask',
    {
      title: 'Ask the A2A agent',
      description:
        'Send a request to the remote A2A agent and wait for its answer. Streams progress while it works. ' +
        'Pass contextId to continue an earlier conversation — the agent keeps its session per context — and ' +
        'taskId as well to answer a task that asked for more input, rather than opening a new one beside it. ' +
        'Interrupting this call does not stop the agent: the task keeps running, and a2a_task or a2a_cancel ' +
        'reach it by the id reported here.',
      inputSchema: z.object({
        text: z.string().min(1).describe('What the agent should do.'),
        contextId: z.string().optional().describe('Continue this conversation instead of starting a new one.'),
        taskId: z
          .string()
          .optional()
          .describe('Continue this specific task — required when answering an input-required question.'),
        agent: agentArg,
      }),
    },
    async ({ text: prompt, contextId, taskId, agent }, ctx: ServerContext): Promise<CallToolResult> => {
      // Progress may only be sent when the caller offered a token to correlate it with.
      // Whether a given client does is not something the docs settle, so it is logged:
      // the whole heartbeat depends on it.
      const progressToken = ctx.mcpReq._meta?.progressToken;
      logs.call('mcp.ask', {
        hasProgressToken: progressToken !== undefined,
        contextId: contextId ?? null,
        taskId: taskId ?? null,
      });

      // What the caller needs to get back to this work if the call does not survive. It
      // starts as what they gave us and is filled in from the stream's first frame.
      const seen: AskIdentity = { agent: agent ?? '', taskId: taskId ?? '', contextId: contextId ?? '' };

      // The gate has to actually stop the turn, not merely note it: recording the verdict
      // and then awaiting the stream anyway would let a wedged agent hold the call exactly
      // as long as doing nothing would have.
      const gate = new AbortController();
      const signals = [ctx.mcpReq.signal, gate.signal].filter(Boolean) as AbortSignal[];
      const signal = signals.length > 1 ? AbortSignal.any(signals) : signals[0];

      let silenceError: string | null = null;
      const beat = new Heartbeat({
        everyMs: opts.heartbeatMs,
        silenceLimitMs: opts.silenceLimitMs,
        send: (progress, message) => {
          if (progressToken === undefined) return;
          void ctx.mcpReq
            .notify({ method: 'notifications/progress', params: { progressToken, progress, message } })
            .catch(() => {});
        },
        onSilence: (silentMs) => {
          silenceError = `the agent sent nothing for ${Math.round(silentMs / 1000)}s — giving up rather than holding the call open`;
          console.log(`  ⨯ upstream silent for ${Math.round(silentMs / 1000)}s, aborting the turn`);
          gate.abort(new Error(silenceError));
        },
      });

      try {
        beat.start();
        const result = await pool.ask(
          { agent, text: prompt, contextId, taskId },
          (update) => {
            seen.agent = update.agent || seen.agent;
            seen.taskId = update.taskId || seen.taskId;
            seen.contextId = update.contextId || seen.contextId;
            console.log(`  ⤷ ${update.text.slice(0, 120)}`);
            beat.touch(update.text);
          },
          signal,
        );
        return renderAsk(result);
      } catch (err) {
        const id = identityOf(err, seen);
        // A caller that hung up never reads what we return, so the handle it would have
        // needed goes to the log instead — the only correlation left for a request that
        // brought no progress token and is no longer listening.
        if (ctx.mcpReq.signal?.aborted && id.taskId) {
          logs.call('mcp.ask.abandoned', { ...id, reason: silenceError ?? 'the caller disconnected' });
        }
        // A turn aborted by the silence gate reports that, not the stream error it caused.
        if (silenceError !== null) return failure(`${silenceError}\n\n${recovery(id)}`, envelopeOf(id));
        return asToolFailure(err, seen);
      } finally {
        beat.stop();
      }
    },
  );

  mcp.registerTool(
    'a2a_task',
    {
      title: 'Read an A2A task',
      description:
        'Fetch a task by id, including its final state, its artifacts and the agent\'s last word on it. Use this ' +
        'to recover a result when a2a_ask was interrupted: the task outlives the call that started it.',
      inputSchema: z.object({ taskId: z.string().min(1), agent: agentArg }),
    },
    async ({ taskId, agent }, ctx: ServerContext): Promise<CallToolResult> => {
      try {
        return renderTask(await pool.task(agent, taskId, ctx.mcpReq.signal));
      } catch (err) {
        return asToolFailure(err);
      }
    },
  );

  mcp.registerTool(
    'a2a_cancel',
    {
      title: 'Cancel an A2A task',
      description: 'Ask the agent to stop working on a task.',
      inputSchema: z.object({ taskId: z.string().min(1), agent: agentArg }),
    },
    async ({ taskId, agent }, ctx: ServerContext): Promise<CallToolResult> => {
      try {
        // Rendered exactly as a read is, because cancelling late does not unmake the work:
        // the ACP bridge publishes its artifact before it reports `CANCELED`, and a caller
        // that stopped a task should not have to fetch it again to see what it produced.
        return renderTask(await pool.cancel(agent, taskId, ctx.mcpReq.signal));
      } catch (err) {
        return asToolFailure(err);
      }
    },
  );

  mcp.registerTool(
    'a2a_card',
    {
      title: 'Read the agent card',
      description: 'Fetch the A2A agent card: who the agent is, what it declares it can do, and which transports it speaks.',
      inputSchema: z.object({ agent: agentArg }),
    },
    async ({ agent }, ctx: ServerContext): Promise<CallToolResult> => {
      try {
        const card = await pool.card(agent, ctx.mcpReq.signal);
        const skills = (card.skills ?? []).map((s) => `${s.id} — ${s.description}`).join('\n');
        return {
          content: [text(`${card.name} (v${card.version})\n${card.description}\n\nSkills:\n${skills}`), json(card)],
        };
      } catch (err) {
        return asToolFailure(err);
      }
    },
  );
};
