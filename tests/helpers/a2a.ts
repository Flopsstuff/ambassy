/**
 * Fixtures for the A2A side: a request context to execute against, and a bus that
 * remembers what an executor published.
 *
 * The bus is the SDK's own `DefaultExecutionEventBus` rather than a stand-in. An
 * executor's contract is about the events it publishes and their order — the first one
 * must be a `task` — and that contract is worth testing through the real object.
 */
import { Role, TaskState, type Message, type Task } from '@a2a-js/sdk';
import {
  DefaultExecutionEventBus,
  RequestContext,
  type AgentExecutionEvent,
  type ExecutionEventBus,
  type ServerCallContext,
} from '@a2a-js/sdk/server';

export const userMessage = (text: string, taskId = '', contextId = ''): Message => ({
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

export interface ContextOptions {
  text?: string;
  taskId?: string;
  contextId?: string;
  /** Set for a follow-up turn, the way the server sets it after INPUT_REQUIRED. */
  task?: Task;
}

export const requestContext = ({
  text = '',
  taskId = 'task-1111-2222',
  contextId = 'ctx-3333-4444',
  task,
}: ContextOptions = {}): RequestContext => {
  const message = userMessage(text, taskId, contextId);
  return new RequestContext(
    { tenant: '', message, configuration: undefined, metadata: undefined },
    taskId,
    contextId,
    // The executors under test read nothing from the call context; a multi-tenant one
    // would, and would then be handed a real builder's output.
    {} as ServerCallContext,
    task,
  );
};

export interface Collected {
  bus: ExecutionEventBus;
  events: AgentExecutionEvent[];
  /** `TaskState` names in publication order — the cycle a client actually observes. */
  states(): string[];
  /** Text of every status message, in order. */
  said(): string[];
  artifacts(): { name: string; text: string; data: unknown }[];
}

const textOf = (parts: Message['parts']): string =>
  parts.map((p) => (p.content?.$case === 'text' ? p.content.value : '')).join('');

const dataOf = (parts: Message['parts']): unknown => {
  for (const part of parts) if (part.content?.$case === 'data') return part.content.value;
  return undefined;
};

export const collect = (): Collected => {
  const bus = new DefaultExecutionEventBus();
  const events: AgentExecutionEvent[] = [];
  bus.on('event', (event) => void events.push(event));

  return {
    bus,
    events,
    states: () =>
      events
        .filter((e) => e.kind === 'statusUpdate')
        .map((e) => TaskState[(e as { data: { status: { state: TaskState } } }).data.status.state]),
    said: () =>
      events
        .filter((e) => e.kind === 'statusUpdate')
        .map((e) => {
          const message = (e as { data: { status: { message?: Message } } }).data.status.message;
          return message ? textOf(message.parts) : '';
        }),
    artifacts: () =>
      events
        .filter((e) => e.kind === 'artifactUpdate')
        .map((e) => {
          const artifact = (e as { data: { artifact: { name: string; parts: Message['parts'] } } }).data.artifact;
          return { name: artifact.name, text: textOf(artifact.parts), data: dataOf(artifact.parts) };
        }),
  };
};
