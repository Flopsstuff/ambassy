/**
 * The vocabulary both servers build their events out of.
 *
 * Worth testing because `Part` has two representations — a discriminated union in
 * TypeScript, a flat object on the wire — and a part built with the wrong `$case` is not
 * an error anyone sees: it arrives as a message the other side reads as empty.
 */
import { Role, TaskState } from '@a2a-js/sdk';
import { describe, expect, it } from 'vitest';
import { agentMessage, dataPart, readText, statusUpdate, textPart } from '../src/parts.ts';

describe('parts', () => {
  it('builds a text part on the `text` case', () => {
    expect(textPart('hello')).toMatchObject({
      content: { $case: 'text', value: 'hello' },
      mediaType: 'text/plain',
    });
  });

  it('builds a data part on the `data` case, carrying the value as it is', () => {
    const value = { stopReason: 'end_turn', toolCalls: [{ title: 'Read' }] };

    expect(dataPart(value)).toMatchObject({
      content: { $case: 'data', value },
      mediaType: 'application/json',
    });
  });
});

describe('agentMessage', () => {
  it('is addressed to the task and the conversation it belongs to', () => {
    const message = agentMessage('task-1', 'ctx-1', [textPart('hi')]);

    expect(message).toMatchObject({ taskId: 'task-1', contextId: 'ctx-1', role: Role.ROLE_AGENT });
  });

  it('gives every message its own id', () => {
    const ids = Array.from({ length: 20 }, () => agentMessage('t', 'c', []).messageId);

    expect(new Set(ids).size).toBe(20);
  });
});

describe('statusUpdate', () => {
  it('stamps the status with an ISO timestamp', () => {
    const event = statusUpdate('task-1', 'ctx-1', TaskState.TASK_STATE_WORKING);

    expect(event.status.state).toBe(TaskState.TASK_STATE_WORKING);
    expect(new Date(event.status.timestamp).toISOString()).toBe(event.status.timestamp);
  });

  it('leaves the message out when there is nothing to say', () => {
    expect(statusUpdate('task-1', 'ctx-1', TaskState.TASK_STATE_COMPLETED).status.message).toBeUndefined();
  });

  it('carries a message when there is', () => {
    const event = statusUpdate(
      'task-1',
      'ctx-1',
      TaskState.TASK_STATE_INPUT_REQUIRED,
      agentMessage('task-1', 'ctx-1', [textPart('what should I do?')]),
    );

    expect(readText(event.status.message!)).toBe('what should I do?');
  });
});

describe('readText', () => {
  const message = (parts: ReturnType<typeof textPart>[]) => agentMessage('t', 'c', parts);

  it('joins the text parts with a space and trims the result', () => {
    expect(readText(message([textPart('  hello'), textPart('world  ')]))).toBe('hello world');
  });

  it('answers an empty string for a message with no parts at all', () => {
    expect(readText(message([]))).toBe('');
  });

  it('ignores the parts that are not text', () => {
    // A message that is only structured data reads as no instruction, which is what
    // sends the task to INPUT_REQUIRED rather than into a prompt.
    expect(readText(message([dataPart({ a: 1 })]))).toBe('');
    expect(readText(message([dataPart({ a: 1 }), textPart('do it')]))).toBe('do it');
  });
});
