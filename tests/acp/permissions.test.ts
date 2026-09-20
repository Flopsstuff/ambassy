/**
 * The classifier is the only thing standing between a task issued by an untrusted A2A
 * caller and a coding agent with a shell, so it is tested as a security boundary: every
 * verdict, both directions, and the paths that look like they stay inside but do not.
 */
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type {
  PermissionOption,
  RequestPermissionRequest,
  ToolCallUpdate,
  ToolKind,
} from '@agentclientprotocol/sdk';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  decidePermission,
  insideRoot,
  readTextFileInsideRoot,
  writeTextFileInsideRoot,
  type Boundary,
  type Supervision,
} from '../../src/acp/permissions.ts';
import { recordingLogs } from '../helpers/logs.ts';
import { tempDir } from '../helpers/tmp.ts';

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

// What Claude offers: a plain allow/reject pair.
const CLAUDE_OPTIONS: PermissionOption[] = [
  { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
  { optionId: 'allow_always', name: 'Allow always', kind: 'allow_always' },
  { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
];

// What Codex offers for a command: `cancel` aborts the whole turn, `decline` refuses
// only this call. Both are `reject_once`, which is why picking one is not trivial.
const CODEX_COMMAND_OPTIONS: PermissionOption[] = [
  { optionId: 'approved', name: 'Approve', kind: 'allow_once' },
  { optionId: 'approved_for_session', name: 'Approve for session', kind: 'allow_always' },
  { optionId: 'decline', name: 'Decline', kind: 'reject_once' },
  { optionId: 'cancel', name: 'Cancel', kind: 'reject_once' },
];

const request = (toolCall: Partial<ToolCallUpdate> & { kind?: ToolKind }, options = CLAUDE_OPTIONS): RequestPermissionRequest =>
  ({
    sessionId: 'sess-abcdef',
    toolCall: { toolCallId: 'call-1', title: 'a tool call', ...toolCall },
    options,
  }) as RequestPermissionRequest;

const supervision = (boundary: Partial<Boundary> & { root: string }, extra: Partial<Supervision> = {}): Supervision => ({
  boundary: { owned: false, allowExecute: false, ...boundary },
  ...extra,
});

describe('insideRoot', () => {
  it('accepts the root itself and anything under it', () => {
    const root = tempDir('root');
    mkdirSync(join(root, 'nested/deeper'), { recursive: true });

    expect(insideRoot(root, root)).toBe(true);
    expect(insideRoot(root, join(root, 'nested'))).toBe(true);
    expect(insideRoot(root, join(root, 'nested/deeper/file.txt'))).toBe(true);
  });

  it('resolves a relative path against the root rather than the process cwd', () => {
    const root = tempDir('root');

    expect(insideRoot(root, 'notes.md')).toBe(true);
    expect(insideRoot(root, './nested/notes.md')).toBe(true);
  });

  it('refuses a path that climbs out, however it is spelled', () => {
    const root = tempDir('root');

    expect(insideRoot(root, '..')).toBe(false);
    expect(insideRoot(root, '../sibling')).toBe(false);
    expect(insideRoot(root, join(root, 'nested/../../escape'))).toBe(false);
    expect(insideRoot(root, '/etc/passwd')).toBe(false);
  });

  it('treats a child whose name merely begins with two dots as a child', () => {
    // `startsWith('..')` alone refuses this, and `..notes` is a file, not a parent.
    const root = tempDir('root');

    expect(insideRoot(root, join(root, '..notes'))).toBe(true);
    expect(insideRoot(root, '..notes')).toBe(true);
  });

  it('follows a symlink out of the root and refuses what it finds', () => {
    const root = tempDir('root');
    const outside = tempDir('outside');
    writeFileSync(join(outside, 'secret.txt'), 'not yours');
    symlinkSync(outside, join(root, 'bridge'));

    expect(insideRoot(root, join(root, 'bridge/secret.txt'))).toBe(false);
  });

  it('accepts a path that reaches the root through a symlink pointing inwards', () => {
    // The agent reports resolved paths, and macOS resolves /var to /private/var: a
    // textual comparison here would deny the agent its own sandbox.
    const root = tempDir('root');
    mkdirSync(join(root, 'real'), { recursive: true });
    symlinkSync(join(root, 'real'), join(root, 'alias'));
    writeFileSync(join(root, 'real/file.txt'), 'mine');

    expect(insideRoot(root, join(root, 'alias/file.txt'))).toBe(true);
  });

  it('judges a file that does not exist yet by the deepest ancestor that does', () => {
    const root = tempDir('root');

    expect(insideRoot(root, join(root, 'not/created/yet.txt'))).toBe(true);
    expect(insideRoot(root, join(root, '../elsewhere/not-created-yet.txt'))).toBe(false);
  });
});

describe('decidePermission: verdicts', () => {
  it('lets read, search and think through without looking at paths', () => {
    const root = tempDir('root');

    for (const kind of ['read', 'search', 'think'] as ToolKind[]) {
      const outcome = decidePermission(
        request({ kind, locations: [{ path: '/etc/passwd' }] }),
        supervision({ root }),
      );

      expect(outcome).toEqual({ outcome: { outcome: 'selected', optionId: 'allow' } });
    }
  });

  it('allows an edit that stays inside the root', () => {
    const root = tempDir('root');

    const outcome = decidePermission(
      request({ kind: 'edit', locations: [{ path: join(root, 'notes.md') }] }),
      supervision({ root }),
    );

    expect(outcome).toEqual({ outcome: { outcome: 'selected', optionId: 'allow' } });
  });

  it('refuses an edit when any one of its locations escapes', () => {
    const root = tempDir('root');
    const denials: string[] = [];

    const outcome = decidePermission(
      request({
        kind: 'edit',
        title: 'Write two files',
        locations: [{ path: join(root, 'fine.md') }, { path: '/etc/hosts' }],
      }),
      supervision({ root }, { onDeny: (summary) => denials.push(summary) }),
    );

    expect(outcome).toEqual({ outcome: { outcome: 'selected', optionId: 'reject' } });
    expect(denials).toHaveLength(1);
    expect(denials[0]).toContain('escapes the root');
    expect(denials[0]).toContain('/etc/hosts');
  });

  it.each(['edit', 'delete', 'move'] as ToolKind[])(
    'decides a location-less %s by who created the root',
    (kind) => {
      const root = tempDir('root');

      const handed = decidePermission(request({ kind }), supervision({ root, owned: false }));
      const ours = decidePermission(request({ kind }), supervision({ root, owned: true }));

      expect(handed).toEqual({ outcome: { outcome: 'selected', optionId: 'reject' } });
      expect(ours).toEqual({ outcome: { outcome: 'selected', optionId: 'allow' } });
    },
  );

  it.each(['execute', 'fetch', 'other'] as ToolKind[])('runs %s only in a root we made ourselves', (kind) => {
    const root = tempDir('root');

    expect(decidePermission(request({ kind }), supervision({ root, owned: true }))).toEqual({
      outcome: { outcome: 'selected', optionId: 'allow' },
    });
    expect(decidePermission(request({ kind }), supervision({ root, owned: false }))).toEqual({
      outcome: { outcome: 'selected', optionId: 'reject' },
    });
  });

  it('treats a tool call with no kind at all as unverifiable', () => {
    const root = tempDir('root');

    expect(decidePermission(request({}), supervision({ root, owned: false }))).toEqual({
      outcome: { outcome: 'selected', optionId: 'reject' },
    });
  });

  it('accepts ACP_ALLOW_EXECUTE as the escape hatch it is', () => {
    const root = tempDir('root');

    const outcome = decidePermission(
      request({ kind: 'execute', title: 'npm install' }),
      supervision({ root, owned: false, allowExecute: true }),
    );

    expect(outcome).toEqual({ outcome: { outcome: 'selected', optionId: 'allow' } });
  });
});

describe('decidePermission: switch_mode', () => {
  const root = () => tempDir('root');

  it('permits a switch that stays in the supervised mode', () => {
    const outcome = decidePermission(
      request({ kind: 'switch_mode', rawInput: { modeId: 'default' } }),
      supervision({ root: root(), owned: true }, { supervisedModeId: 'default' }),
    );

    expect(outcome).toEqual({ outcome: { outcome: 'selected', optionId: 'allow' } });
  });

  it('refuses a switch out of it even when the root is our own sandbox', () => {
    // Owning the directory decides nothing: the mode is what makes the adapter ask at
    // all, so leaving it is a request to stop being supervised.
    const denials: string[] = [];

    const outcome = decidePermission(
      request({ kind: 'switch_mode', title: 'Switch to acceptEdits', rawInput: { modeId: 'acceptEdits' } }),
      supervision({ root: root(), owned: true }, { supervisedModeId: 'default', onDeny: (d) => denials.push(d) }),
    );

    expect(outcome).toEqual({ outcome: { outcome: 'selected', optionId: 'reject' } });
    expect(denials[0]).toContain("would leave the supervised mode default");
  });

  it.each([
    ['mode', { mode: 'read-only' }],
    ['currentModeId', { currentModeId: 'read-only' }],
  ])('reads the target mode from rawInput.%s', (_key, rawInput) => {
    const outcome = decidePermission(
      request({ kind: 'switch_mode', rawInput }),
      supervision({ root: root(), owned: true }, { supervisedModeId: 'read-only' }),
    );

    expect(outcome).toEqual({ outcome: { outcome: 'selected', optionId: 'allow' } });
  });

  it.each([
    ['no rawInput at all', undefined],
    ['a rawInput that is not an object', 'read-only'],
    ['an object naming no mode', { reason: 'because' }],
  ])('refuses a switch with %s', (_label, rawInput) => {
    const outcome = decidePermission(
      request({ kind: 'switch_mode', rawInput } as Partial<ToolCallUpdate>),
      supervision({ root: root(), owned: true }, { supervisedModeId: 'default' }),
    );

    expect(outcome).toEqual({ outcome: { outcome: 'selected', optionId: 'reject' } });
  });

  it('refuses when no supervised mode is known, rather than guessing one', () => {
    // The startup handshake has no session, so it has no mode either.
    const outcome = decidePermission(
      request({ kind: 'switch_mode', rawInput: { modeId: 'default' } }),
      supervision({ root: root(), owned: true }),
    );

    expect(outcome).toEqual({ outcome: { outcome: 'selected', optionId: 'reject' } });
  });
});

describe('decidePermission: leaving plan mode', () => {
  // Neither adapter puts the destination in `rawInput` — it is in the option ids, read
  // here off the adapters' own tables. These are the real ones, verbatim.
  const CLAUDE_EXIT_PLAN: PermissionOption[] = [
    { optionId: 'exit-plan-clear-accept-edits', name: 'Yes, clear context and auto-accept edits', kind: 'allow_always' },
    { optionId: 'exit-plan-accept-edits', name: 'Yes, auto-accept edits', kind: 'allow_always' },
    { optionId: 'exit-plan-default', name: 'Yes, manually approve edits', kind: 'allow_once' },
    { optionId: 'reject', name: 'No, keep planning', kind: 'reject_once' },
  ];

  const CODEX_PLAN_REVIEW: PermissionOption[] = [
    { optionId: 'implement_plan', name: 'Yes, implement this plan', kind: 'allow_once' },
    { optionId: 'revise_plan', name: 'No, and tell Codex what to do differently', kind: 'reject_once' },
  ];

  const planCall = (rawInput: unknown = { plan: 'do the thing' }) =>
    request({ kind: 'switch_mode', title: 'Implement this plan?', rawInput } as Partial<ToolCallUpdate>);

  it('picks the exit that keeps the session supervised', () => {
    const outcome = decidePermission(
      { ...planCall(), options: CLAUDE_EXIT_PLAN },
      supervision({ root: tempDir('root'), owned: true }, { supervisedModeId: 'default' }),
    );

    // "Yes, manually approve edits" leaves planning and still asks us about every call.
    expect(outcome).toEqual({ outcome: { outcome: 'selected', optionId: 'exit-plan-default' } });
  });

  it('takes the option it named rather than the first of the right kind', () => {
    // The verdict carries an option id here, and it outranks the kind-by-kind search that
    // answers every other tool call — which would have taken this unrelated allow_once.
    const withDecoy: PermissionOption[] = [
      { optionId: 'allow-once', name: 'Yes', kind: 'allow_once' },
      ...CLAUDE_EXIT_PLAN,
    ];

    const outcome = decidePermission(
      { ...planCall(), options: withDecoy },
      supervision({ root: tempDir('root'), owned: true }, { supervisedModeId: 'default' }),
    );

    expect(outcome).toEqual({ outcome: { outcome: 'selected', optionId: 'exit-plan-default' } });
  });

  it('approves a plan whose approval changes no mode at all', () => {
    // Codex asks "Implement this plan?" and stays where it is either way; refusing only
    // sends it back to revising.
    const outcome = decidePermission(
      { ...planCall(), options: CODEX_PLAN_REVIEW },
      supervision({ root: tempDir('root'), owned: true }, { supervisedModeId: 'read-only' }),
    );

    expect(outcome).toEqual({ outcome: { outcome: 'selected', optionId: 'implement_plan' } });
  });

  it('refuses when every offered exit drops supervision', () => {
    const denials: string[] = [];
    const elevatingOnly = CLAUDE_EXIT_PLAN.filter((o) => o.optionId !== 'exit-plan-default');

    const outcome = decidePermission(
      { ...planCall(), options: elevatingOnly },
      supervision({ root: tempDir('root'), owned: true }, { supervisedModeId: 'default', onDeny: (d) => denials.push(d) }),
    );

    expect(outcome).toEqual({ outcome: { outcome: 'selected', optionId: 'reject' } });
    expect(denials[0]).toContain('offers only modes that drop supervision');
    expect(denials[0]).toContain('exit-plan-clear-accept-edits');
  });

  it('refuses an exit it has never heard of rather than guessing', () => {
    const outcome = decidePermission(
      { ...planCall(), options: [{ optionId: 'exit-plan-to-somewhere-new', name: 'Yes', kind: 'allow_once' }] },
      supervision({ root: tempDir('root'), owned: true }, { supervisedModeId: 'default' }),
    );

    expect(outcome).toEqual({ outcome: { outcome: 'cancelled' } });
  });

  it('still reads an explicit destination out of rawInput when there is one', () => {
    // The two paths are not alternatives: a named mode is checked directly, and only a
    // request that names none is answered by choosing among the options.
    const outcome = decidePermission(
      { ...planCall({ modeId: 'bypassPermissions' }), options: CLAUDE_EXIT_PLAN },
      supervision({ root: tempDir('root'), owned: true }, { supervisedModeId: 'default' }),
    );

    expect(outcome).toEqual({ outcome: { outcome: 'selected', optionId: 'reject' } });
  });
});

describe('decidePermission: choosing among the offered options', () => {
  it('prefers declining a single call over cancelling the whole turn', () => {
    const root = tempDir('root');

    const outcome = decidePermission(
      request({ kind: 'execute', title: 'rm -rf /' }, CODEX_COMMAND_OPTIONS),
      supervision({ root, owned: false }),
    );

    expect(outcome).toEqual({ outcome: { outcome: 'selected', optionId: 'decline' } });
  });

  it('falls back to cancel when declining is not on the table', () => {
    // Codex offers no `decline` on file edits; cancelling is then the only refusal.
    const root = tempDir('root');
    const editOptions = CODEX_COMMAND_OPTIONS.filter((o) => o.optionId !== 'decline');

    const outcome = decidePermission(
      request({ kind: 'edit', locations: [{ path: '/etc/hosts' }] }, editOptions),
      supervision({ root, owned: true }),
    );

    expect(outcome).toEqual({ outcome: { outcome: 'selected', optionId: 'cancel' } });
  });

  it('takes allow_always when allow_once was not offered', () => {
    const root = tempDir('root');
    const onlyAlways: PermissionOption[] = [
      { optionId: 'always', name: 'Always', kind: 'allow_always' },
      { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
    ];

    const outcome = decidePermission(request({ kind: 'read' }, onlyAlways), supervision({ root }));

    expect(outcome).toEqual({ outcome: { outcome: 'selected', optionId: 'always' } });
  });

  it('answers `cancelled` rather than inventing an option id nobody offered', () => {
    // Claude fails the entire turn with "Permission option was not offered"; Codex
    // silently downgrades the answer to a cancel and logs nothing.
    const root = tempDir('root');
    const denials: string[] = [];
    const onlyAllow: PermissionOption[] = [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }];

    const outcome = decidePermission(
      request({ kind: 'execute', title: 'curl example.com' }, onlyAllow),
      supervision({ root, owned: false }, { onDeny: (d) => denials.push(d) }),
    );

    expect(outcome).toEqual({ outcome: { outcome: 'cancelled' } });
    expect(denials).toHaveLength(1);
  });

  it('cancels a permitted call too when no allow option exists', () => {
    const root = tempDir('root');
    const onlyReject: PermissionOption[] = [{ optionId: 'reject', name: 'Reject', kind: 'reject_once' }];

    expect(decidePermission(request({ kind: 'read' }, onlyReject), supervision({ root }))).toEqual({
      outcome: { outcome: 'cancelled' },
    });
  });
});

describe('decidePermission: what reaches the log', () => {
  it('records the decision, the reason, the paths and the options that were offered', () => {
    const root = tempDir('root');
    const logs = recordingLogs();

    decidePermission(
      request({ kind: 'edit', title: 'Edit hosts', locations: [{ path: '/etc/hosts' }] }),
      supervision({ root }, { log: logs.work }),
    );

    expect(logs.works).toHaveLength(1);
    expect(logs.works[0]).toMatchObject({
      event: 'permission',
      fields: {
        sessionId: 'sess-abcdef',
        toolCallId: 'call-1',
        title: 'Edit hosts',
        kind: 'edit',
        decision: 'deny',
        optionId: 'reject',
        locations: ['/etc/hosts'],
      },
    });
    expect(logs.works[0].fields.offered).toEqual([
      { optionId: 'allow', kind: 'allow_once' },
      { optionId: 'allow_always', kind: 'allow_always' },
      { optionId: 'reject', kind: 'reject_once' },
    ]);
  });

  it('falls back to the tool call id when the agent sent no title', () => {
    const root = tempDir('root');
    const logs = recordingLogs();

    decidePermission(
      { sessionId: 's', toolCall: { toolCallId: 'call-42', kind: 'read' }, options: CLAUDE_OPTIONS } as RequestPermissionRequest,
      supervision({ root }, { log: logs.work }),
    );

    expect(logs.works[0].fields).toMatchObject({ title: 'call-42', decision: 'allow' });
  });

  it('logs a cancelled decision with no option id', () => {
    const root = tempDir('root');
    const logs = recordingLogs();

    decidePermission(
      request({ kind: 'execute' }, [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }]),
      supervision({ root }, { log: logs.work }),
    );

    expect(logs.works[0].fields).toMatchObject({ decision: 'cancelled', optionId: null });
  });
});

describe('fs handlers', () => {
  const sessionId = 'sess-abcdef';

  it('reads a file inside the root and logs its size', async () => {
    const root = tempDir('root');
    writeFileSync(join(root, 'notes.md'), 'one\ntwo\nthree');
    const logs = recordingLogs();

    const response = await readTextFileInsideRoot(
      { sessionId, path: join(root, 'notes.md') },
      supervision({ root }, { log: logs.work }),
    );

    expect(response.content).toBe('one\ntwo\nthree');
    expect(logs.works[0]).toMatchObject({ event: 'fs.read', fields: { path: 'notes.md', bytes: 13 } });
  });

  it('honours line and limit, counting lines from one', async () => {
    const root = tempDir('root');
    writeFileSync(join(root, 'notes.md'), 'one\ntwo\nthree\nfour');

    const fromSecond = await readTextFileInsideRoot(
      { sessionId, path: join(root, 'notes.md'), line: 2 },
      supervision({ root }),
    );
    const justTwo = await readTextFileInsideRoot(
      { sessionId, path: join(root, 'notes.md'), line: 2, limit: 2 },
      supervision({ root }),
    );

    expect(fromSecond.content).toBe('two\nthree\nfour');
    expect(justTwo.content).toBe('two\nthree');
  });

  it('refuses to read outside the root and says so in the log', async () => {
    const root = tempDir('root');
    const outside = tempDir('outside');
    writeFileSync(join(outside, 'secret.txt'), 'not yours');
    const logs = recordingLogs();

    await expect(
      readTextFileInsideRoot({ sessionId, path: join(outside, 'secret.txt') }, supervision({ root }, { log: logs.work })),
    ).rejects.toThrow(/escapes the session root/);

    expect(logs.works[0]).toMatchObject({ event: 'fs.denied' });
  });

  it('writes a file, creating the directories it needs', async () => {
    const root = tempDir('root');
    const logs = recordingLogs();

    await writeTextFileInsideRoot(
      { sessionId, path: join(root, 'deep/nested/hello.txt'), content: 'hi' },
      supervision({ root }, { log: logs.work }),
    );

    expect(readFileSync(join(root, 'deep/nested/hello.txt'), 'utf8')).toBe('hi');
    expect(logs.works[0]).toMatchObject({ event: 'fs.write', fields: { path: 'deep/nested/hello.txt', bytes: 2 } });
  });

  it('refuses to write outside the root, and writes nothing at all', async () => {
    const root = tempDir('root');
    const outside = tempDir('outside');

    await expect(
      writeTextFileInsideRoot(
        { sessionId, path: join(outside, 'planted.txt'), content: 'mine now' },
        supervision({ root }),
      ),
    ).rejects.toThrow(/escapes the session root/);

    expect(() => readFileSync(join(outside, 'planted.txt'), 'utf8')).toThrow();
  });

  it('refuses a relative path that climbs out of the root', async () => {
    const root = tempDir('root');

    await expect(
      writeTextFileInsideRoot({ sessionId, path: '../escaped.txt', content: 'x' }, supervision({ root })),
    ).rejects.toThrow(/escapes the session root/);
  });
});
