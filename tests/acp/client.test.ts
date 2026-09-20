/**
 * The backend table is three strings per adapter, and one of them is a security
 * decision: the mode in which the adapter asks the bridge before it acts. Both defaults
 * were caught routing that decision elsewhere, so the values are pinned here.
 */
import type { ActiveSession, ClientConnection } from '@agentclientprotocol/sdk';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BACKENDS, superviseMode } from '../../src/acp/client.ts';

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

describe('BACKENDS', () => {
  it('knows the two adapters the launch scripts name', () => {
    expect(Object.keys(BACKENDS)).toEqual(['claude', 'codex']);
  });

  it('puts Claude in `default`, where it asks instead of approving its own calls', () => {
    // Claude otherwise inherits the human's `permissions.defaultMode`; where that is
    // `auto`, not one permission request reaches the bridge.
    expect(BACKENDS.claude).toEqual({
      id: 'claude',
      bin: 'claude-agent-acp',
      label: 'Claude',
      supervisedModeId: 'default',
    });
  });

  it('puts Codex in `read-only`, the mode whose reviewer is the client', () => {
    // `agent` mode carries approvalsReviewer: "auto_review", which answers on the
    // client's behalf — under it Codex overwrote a file two directories above its root.
    // The name is about approvals, not about writing: inside the workspace it still edits.
    expect(BACKENDS.codex).toEqual({
      id: 'codex',
      bin: 'codex-acp',
      label: 'Codex',
      supervisedModeId: 'read-only',
    });
  });

  it('keeps the id and the map key in step, since both name the backend', () => {
    for (const [key, backend] of Object.entries(BACKENDS)) expect(backend.id).toBe(key);
  });
});

describe('superviseMode', () => {
  const session = (modes: { currentModeId: string; availableModes: { id: string }[] } | null | undefined) =>
    ({ sessionId: 'sess-abcdef12', modes }) as unknown as Pick<ActiveSession, 'sessionId' | 'modes'>;

  const connection = () => {
    const requests: { method: unknown; params: unknown }[] = [];
    const conn = {
      agent: {
        request: async (method: unknown, params: unknown) => {
          requests.push({ method, params });
          return {};
        },
      },
    } as unknown as Pick<ClientConnection, 'agent'>;
    return { conn, requests };
  };

  it('leaves a session that is already supervised alone', async () => {
    const { conn, requests } = connection();

    const mode = await superviseMode(
      conn,
      session({ currentModeId: 'default', availableModes: [{ id: 'default' }, { id: 'acceptEdits' }] }),
      BACKENDS.claude,
      'ctx-1',
    );

    expect(mode).toBe('default');
    expect(requests).toEqual([]);
  });

  it('switches a session that came up in another mode', async () => {
    // Claude inherits the human's permissions.defaultMode, and Codex's `agent` mode
    // answers its own permission requests — neither is a mode to prompt in.
    const { conn, requests } = connection();

    const mode = await superviseMode(
      conn,
      session({ currentModeId: 'agent', availableModes: [{ id: 'agent' }, { id: 'read-only' }] }),
      BACKENDS.codex,
      'ctx-1',
    );

    expect(mode).toBe('read-only');
    expect(requests).toHaveLength(1);
    expect(requests[0].params).toEqual({ sessionId: 'sess-abcdef12', modeId: 'read-only' });
  });

  it('refuses to prompt at all when the mode is not on offer', async () => {
    // Logging the miss and prompting anyway would leave the bridge reporting a
    // supervision it is no longer performing.
    const { conn, requests } = connection();

    await expect(
      superviseMode(conn, session({ currentModeId: 'auto', availableModes: [{ id: 'auto' }] }), BACKENDS.claude, 'ctx-1'),
    ).rejects.toThrow(/does not offer the supervised mode 'default' \(offered: auto\); refusing to prompt unsupervised/);

    expect(requests).toEqual([]);
  });

  it('refuses just as firmly when the adapter reports no modes at all', async () => {
    const { conn } = connection();

    await expect(superviseMode(conn, session(null), BACKENDS.codex, 'ctx-1')).rejects.toThrow(/offered: none/);
  });
});
