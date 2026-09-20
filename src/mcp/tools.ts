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
 */
import { TaskState } from '@a2a-js/sdk';
import type { Task } from '@a2a-js/sdk';
import type { CallToolResult, McpServer, ServerContext } from '@modelcontextprotocol/server';
import { z } from 'zod';

import type { Logs } from '../acp/log.ts';
import { A2APool, UnknownAgentError, type AskResult } from './a2a.ts';
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

const failure = (message: string): CallToolResult => ({ content: [text(message)], isError: true });

/** An unknown alias is the caller's mistake to correct, not a protocol error to trap. */
const asToolFailure = (err: unknown): CallToolResult =>
  failure(err instanceof UnknownAgentError ? err.message : `A2A call failed: ${(err as Error).message ?? String(err)}`);

// --- rendering what came back ---

const renderAsk = (result: AskResult): CallToolResult => {
  const envelope = {
    taskId: result.taskId,
    contextId: result.contextId,
    state: TaskState[result.state],
    ...(result.data !== undefined ? { agent: result.data } : {}),
  };

  if (result.state === TaskState.TASK_STATE_INPUT_REQUIRED) {
    return {
      content: [
        text(
          `The agent needs more input before it can finish.\n\n${result.question || '(it did not say what)'}\n\n` +
            `Answer by calling a2a_ask again with contextId "${result.contextId}" — the task stays open.`,
        ),
        json(envelope),
      ],
    };
  }

  const failed = result.state === TaskState.TASK_STATE_FAILED || result.state === TaskState.TASK_STATE_REJECTED;
  return {
    content: [text(result.answer || `(the agent finished in ${TaskState[result.state]} without producing an answer)`), json(envelope)],
    ...(failed ? { isError: true } : {}),
  };
};

const renderTask = (task: Task): CallToolResult => {
  const artifacts = (task.artifacts ?? []).map((a) => ({
    name: a.name,
    text: a.parts.map((p) => (p.content?.$case === 'text' ? p.content.value : '')).join(''),
  }));
  return {
    content: [
      text(`Task ${task.id} is ${TaskState[task.status.state]}, with ${artifacts.length} artifact(s).`),
      json({ taskId: task.id, contextId: task.contextId, state: TaskState[task.status.state], artifacts }),
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
        'Pass contextId to continue an earlier conversation — the agent keeps its session per context.',
      inputSchema: z.object({
        text: z.string().min(1).describe('What the agent should do.'),
        contextId: z.string().optional().describe('Continue this conversation instead of starting a new one.'),
        agent: agentArg,
      }),
    },
    async ({ text: prompt, contextId, agent }, ctx: ServerContext): Promise<CallToolResult> => {
      // Progress may only be sent when the caller offered a token to correlate it with.
      // Whether a given client does is not something the docs settle, so it is logged:
      // the whole heartbeat depends on it.
      const progressToken = ctx.mcpReq._meta?.progressToken;
      logs.call('mcp.ask', { hasProgressToken: progressToken !== undefined, contextId: contextId ?? null });

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
        const result = await pool.ask({ agent, text: prompt, contextId }, (update) => {
          console.log(`  ⤷ ${update.text.slice(0, 120)}`);
          beat.touch(update.text);
        }, signal);
        return renderAsk(result);
      } catch (err) {
        // A turn aborted by the silence gate reports that, not the stream error it caused.
        return silenceError !== null ? failure(silenceError) : asToolFailure(err);
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
        'Fetch a task by id, including its final state and artifacts. Use this to recover a result when a2a_ask ' +
        'was interrupted: the task outlives the call that started it.',
      inputSchema: z.object({ taskId: z.string().min(1), agent: agentArg }),
    },
    async ({ taskId, agent }): Promise<CallToolResult> => {
      try {
        return renderTask(await pool.task(agent, taskId));
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
    async ({ taskId, agent }): Promise<CallToolResult> => {
      try {
        const task = await pool.cancel(agent, taskId);
        return { content: [text(`Task ${task.id} is now ${TaskState[task.status.state]}.`)] };
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
    async ({ agent }): Promise<CallToolResult> => {
      try {
        const card = await pool.card(agent);
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
