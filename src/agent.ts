/**
 * A2A server: a minimal agent showing what the protocol is actually for —
 * a stateful task with a multi-turn conversation (INPUT_REQUIRED), streamed
 * status updates, and an artifact as the result.
 *
 * The "Revisor" agent: computes statistics over the text it is given.
 */
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

const PORT = Number(process.env.PORT ?? 41241);
// The URL the agent advertises in its card. Override it to route clients through the wire-tap.
const PUBLIC_URL = process.env.PUBLIC_URL ?? `http://localhost:${PORT}/`;

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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// --- the agent's own logic ---

function analyze(text: string) {
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

class RevisorExecutor implements AgentExecutor {
  private readonly cancelled = new Set<string>();

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
        await sleep(600);

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

// --- Agent Card: the business card every interaction starts from ---

const agentCard: AgentCard = {
  name: 'Revisor',
  description: 'Computes text statistics. A demo agent for learning A2A v1.0.',
  supportedInterfaces: [
    {
      url: PUBLIC_URL,
      protocolBinding: 'JSONRPC',
      tenant: '',
      protocolVersion: A2A_PROTOCOL_VERSION,
    },
  ],
  provider: { organization: 'Flopsstuff', url: 'https://example.local' },
  version: '0.1.0',
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
      id: 'text_stats',
      name: 'Text statistics',
      description: 'Words, characters, sentences and the most frequent words.',
      tags: ['text', 'analysis'],
      examples: ['Count the words in this paragraph'],
      inputModes: ['text'],
      outputModes: ['text', 'data'],
      securityRequirements: [],
    },
  ],
  documentationUrl: '',
  signatures: [],
};

const requestHandler = new DefaultRequestHandler(agentCard, new InMemoryTaskStore(), new RevisorExecutor());

const app = express();
app.use((req, _res, next) => {
  console.log(`  ← ${req.method} ${req.originalUrl}`);
  next();
});
app.use(`/${AGENT_CARD_PATH}`, agentCardHandler({ agentCardProvider: requestHandler }));
app.use(jsonRpcHandler({ requestHandler, userBuilder: UserBuilder.noAuthentication }));

app.listen(PORT, () => {
  console.log(`Revisor listening on http://localhost:${PORT}`);
  console.log(`Agent Card:          http://localhost:${PORT}/${AGENT_CARD_PATH}`);
});
