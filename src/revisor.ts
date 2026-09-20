/**
 * The stub agent's own logic: text statistics, and the executor that publishes them.
 *
 * Kept apart from `src/agent.ts` because that file is a bootstrap — it reads the
 * environment, builds the Agent Card and binds a port the moment it is imported, which
 * makes it unreachable from anywhere but a running server. What is interesting about the
 * agent is the shape of the events it publishes, and that is here.
 */
import { TaskState, type Artifact, type Task, type TaskArtifactUpdateEvent } from '@a2a-js/sdk';
import {
  AgentEvent,
  type AgentExecutor,
  type ExecutionEventBus,
  type RequestContext,
} from '@a2a-js/sdk/server';
import { agentMessage, dataPart, readText, statusUpdate, textPart } from './parts.ts';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface TextStats {
  characters: number;
  words: number;
  sentences: number;
  averageWordLength: number;
  topWords: { word: string; count: number }[];
}

/**
 * What the agent actually computes.
 *
 * Words shorter than four characters are left out of the frequency count on purpose —
 * otherwise the top of every list is "the", "and", "a" and says nothing about the text.
 */
export function analyze(text: string): TextStats {
  const words = text.split(/\s+/).filter(Boolean);
  const freq = new Map<string, number>();
  for (const w of words) {
    const key = w.toLowerCase().replace(/[^\p{L}\p{N}-]/gu, '');
    if (key.length > 3) freq.set(key, (freq.get(key) ?? 0) + 1);
  }
  return {
    characters: text.length,
    words: words.length,
    sentences: text.split(/[.!?…]+/).filter((s) => s.trim()).length,
    averageWordLength: words.length
      ? Number((words.reduce((a, w) => a + w.length, 0) / words.length).toFixed(2))
      : 0,
    topWords: [...freq.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([word, count]) => ({ word, count })),
  };
}

export interface RevisorOptions {
  /**
   * How long each streamed step pretends to work.
   *
   * The pause is the whole reason the client sees two WORKING frames instead of one
   * instant COMPLETED, so it stays in by default — and a caller that is not watching the
   * stream (a test) can set it to zero rather than wait out a demonstration.
   */
  stepDelayMs?: number;
}

export class RevisorExecutor implements AgentExecutor {
  private readonly cancelled = new Set<string>();
  private readonly stepDelayMs: number;

  constructor(opts: RevisorOptions = {}) {
    this.stepDelayMs = opts.stepDelayMs ?? 600;
  }

  cancelTask = async (taskId: string): Promise<void> => {
    console.log(`  ↯ cancellation requested for task ${taskId}`);
    this.cancelled.add(taskId);
  };

  async execute(ctx: RequestContext, bus: ExecutionEventBus): Promise<void> {
    const { taskId, contextId, task: existingTask } = ctx;
    const userMessage = ctx.userMessage;
    const text = readText(userMessage);

    console.log(
      `\n▶ execute: task=${taskId.slice(0, 8)} context=${contextId.slice(0, 8)} ` +
        `${existingTask ? '(resuming task)' : '(new task)'} text=${JSON.stringify(text.slice(0, 40))}`,
    );

    try {
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

      // No text is not an error but a non-terminal state: the task stays alive, awaiting input.
      if (!text) {
        console.log('  ⤷ nothing to analyze → INPUT_REQUIRED (task stays open)');
        bus.publish(
          AgentEvent.statusUpdate(
            statusUpdate(
              taskId,
              contextId,
              TaskState.TASK_STATE_INPUT_REQUIRED,
              agentMessage(taskId, contextId, [
                textPart('Send me some text to analyze — reply into this same task.'),
              ]),
            ),
          ),
        );
        return;
      }

      // Stream progress: the client sees these as they happen, not at the end.
      for (const step of ['Reading the text…', 'Counting word frequencies…']) {
        bus.publish(
          AgentEvent.statusUpdate(
            statusUpdate(
              taskId,
              contextId,
              TaskState.TASK_STATE_WORKING,
              agentMessage(taskId, contextId, [textPart(step)]),
            ),
          ),
        );
        console.log(`  ⤷ working: ${step}`);
        if (this.stepDelayMs > 0) await sleep(this.stepDelayMs);

        if (this.cancelled.has(taskId)) {
          console.log('  ⤷ cancelled');
          bus.publish(AgentEvent.statusUpdate(statusUpdate(taskId, contextId, TaskState.TASK_STATE_CANCELED)));
          return;
        }
      }

      const stats = analyze(text);
      const artifact: Artifact = {
        artifactId: crypto.randomUUID(),
        name: 'text-stats',
        description: 'Statistics for the submitted text',
        parts: [
          textPart(`Words: ${stats.words}, characters: ${stats.characters}, sentences: ${stats.sentences}.`),
          dataPart(stats), // structured part: a machine reads this instead of parsing the string
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
      bus.publish(AgentEvent.statusUpdate(statusUpdate(taskId, contextId, TaskState.TASK_STATE_COMPLETED)));
      console.log('  ⤷ completed, artifact delivered');
    } finally {
      this.cancelled.delete(taskId);
    }
  }
}
