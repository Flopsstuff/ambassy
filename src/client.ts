/**
 * A2A client: discovers an agent through its Agent Card, holds a two-turn
 * conversation with it, and prints every stream event.
 *
 * Turn 1 — an empty message → the agent moves the task to INPUT_REQUIRED.
 * Turn 2 — we send the text into THE SAME task → the agent drives it to COMPLETED.
 * That is the difference between A2A and a plain "POST /do": the call has state.
 */
import { Role, TaskState, type Message, type Part, type StreamResponse, type TaskStatus } from '@a2a-js/sdk';
import { ClientFactory } from '@a2a-js/sdk/client';

const BASE_URL = process.env.AGENT_URL || 'http://localhost:41241';

const userMessage = (text: string, taskId = '', contextId = ''): Message => ({
  messageId: crypto.randomUUID(),
  contextId,
  taskId,
  role: Role.ROLE_USER,
  parts: text
    ? [{ content: { $case: 'text', value: text }, metadata: undefined, filename: '', mediaType: 'text/plain' }]
    : [],
  metadata: {},
  extensions: [],
  referenceTaskIds: [],
});

const renderParts = (parts: Part[]): string =>
  parts
    .map((p) => {
      if (p.content?.$case === 'text') return p.content.value;
      if (p.content?.$case === 'data') return JSON.stringify(p.content.value, null, 2);
      return `<${p.content?.$case ?? 'empty'}>`;
    })
    .join('\n');

// `status` and `artifact` are optional in the generated types, because every message
// field of a protobuf is. One helper keeps that fact out of the printing below.
const stateOf = (status: TaskStatus | undefined): TaskState => status?.state ?? TaskState.TASK_STATE_UNSPECIFIED;

/** Prints a stream event and returns whatever task identifiers it carried. */
function render(event: StreamResponse): { taskId?: string; contextId?: string; state?: TaskState } {
  const p = event.payload;
  switch (p?.$case) {
    case 'task':
      console.log(`  [task]           id=${p.value.id.slice(0, 8)} state=${TaskState[stateOf(p.value.status)]}`);
      return { taskId: p.value.id, contextId: p.value.contextId, state: stateOf(p.value.status) };
    case 'statusUpdate': {
      const message = p.value.status?.message;
      const note = message ? ` — ${renderParts(message.parts)}` : '';
      console.log(`  [statusUpdate]   ${TaskState[stateOf(p.value.status)]}${note}`);
      return { taskId: p.value.taskId, contextId: p.value.contextId, state: stateOf(p.value.status) };
    }
    case 'artifactUpdate': {
      const artifact = p.value.artifact;
      const body = artifact ? `«${artifact.name}»\n${renderParts(artifact.parts)}` : '(an update with no artifact)';
      console.log(`  [artifactUpdate] ${body}`);
      return { taskId: p.value.taskId, contextId: p.value.contextId };
    }
    case 'message':
      console.log(`  [message]        ${renderParts(p.value.parts)}`);
      return {};
    default:
      // The union is exhausted above, so what lands here is either an absent payload or a
      // case from a newer protocol than these branches know: nothing to name it by.
      console.log(`  [unrecognised]   ${JSON.stringify(p)}`);
      return {};
  }
}

async function main() {
  // createFromUrl fetches /.well-known/agent-card.json itself and picks a transport
  // from supportedInterfaces — the client hardcodes neither a method URL nor a protocol.
  const factory = new ClientFactory();
  const client = await factory.createFromUrl(BASE_URL);
  console.log(`Connected to ${BASE_URL}\n`);

  let taskId = '';
  let contextId = '';
  let state: TaskState | undefined;

  console.log('── Turn 1: sending an empty message ──');
  for await (const event of client.sendMessageStream({
    tenant: '',
    message: userMessage(''),
    configuration: undefined,
    metadata: undefined,
  })) {
    const seen = render(event);
    taskId = seen.taskId ?? taskId;
    contextId = seen.contextId ?? contextId;
    state = seen.state ?? state;
  }

  if (state !== TaskState.TASK_STATE_INPUT_REQUIRED) {
    console.log(`\nExpected INPUT_REQUIRED, got ${state !== undefined ? TaskState[state] : 'nothing'}.`);
    return;
  }

  console.log(`\n── Turn 2: sending the text into the same task ${taskId.slice(0, 8)} ──`);
  const text =
    'A2A describes horizontal interaction between agents. ' +
    'MCP describes the vertical connection to tools. ' +
    'The A2A protocol makes a task stateful, and that is its main difference from a plain HTTP call.';

  for await (const event of client.sendMessageStream({
    tenant: '',
    message: userMessage(text, taskId, contextId),
    configuration: undefined,
    metadata: undefined,
  })) {
    render(event);
  }

  // The task outlived both calls and sits on the server in full — history and artifacts included.
  const task = await client.getTask({ tenant: '', id: taskId, historyLength: 0 });
  console.log(
    `\n── Result: GetTask(${taskId.slice(0, 8)}) → ${TaskState[stateOf(task.status)]}, ` +
      `artifacts: ${task.artifacts?.length ?? 0}, history messages: ${task.history?.length ?? 0} ──`,
  );
}

main().catch((err) => {
  console.error('Error:', err);
  process.exit(1);
});
