/**
 * The bearer guard is the only thing in front of the MCP endpoint, and the endpoint is
 * the side of this repository meant to face a network. So the tests cover both halves:
 * the token file an operator reads, and the 401 that tells a client what it needs.
 */
import { chmodSync, existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { NextFunction, Request, Response } from 'express';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { bearerGuard, mintToken, persistToken, readToken, tokenMatches } from '../../src/mcp/auth.ts';
import { tempDir } from '../helpers/tmp.ts';

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

interface FakeResponse {
  statusCode: number | null;
  headers: Record<string, string>;
  body: unknown;
  status(code: number): FakeResponse;
  set(name: string, value: string): FakeResponse;
  json(payload: unknown): FakeResponse;
}

const fakeResponse = (): FakeResponse => ({
  statusCode: null,
  headers: {},
  body: undefined,
  status(code) {
    this.statusCode = code;
    return this;
  },
  set(name, value) {
    this.headers[name] = value;
    return this;
  },
  json(payload) {
    this.body = payload;
    return this;
  },
});

const call = (guard: ReturnType<typeof bearerGuard>, authorization?: string) => {
  const res = fakeResponse();
  let passed = false;
  const next: NextFunction = () => {
    passed = true;
  };
  guard(
    { headers: authorization === undefined ? {} : { authorization }, method: 'POST', originalUrl: '/mcp' } as Request,
    res as unknown as Response,
    next,
  );
  return { res, passed };
};

describe('mintToken', () => {
  it('produces 32 bytes of base64url — 43 characters that need no escaping', () => {
    const token = mintToken();

    expect(token).toHaveLength(43);
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('produces a different token every time', () => {
    expect(new Set(Array.from({ length: 50 }, mintToken)).size).toBe(50);
  });
});

describe('persistToken / readToken', () => {
  it('writes the token with a trailing newline and reads it back without one', () => {
    const path = join(tempDir('mcp'), '.mcp-token');
    const token = mintToken();

    persistToken(path, token);

    expect(readFileSync(path, 'utf8')).toBe(`${token}\n`);
    expect(readToken(path)).toBe(token);
  });

  it('locks the file down to the owner', () => {
    const path = join(tempDir('mcp'), '.mcp-token');

    persistToken(path, mintToken());

    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it('tightens an existing file that was readable by everyone', () => {
    // writeFileSync's mode only applies when it creates the file, which is why the
    // chmod afterwards is not redundant.
    const path = join(tempDir('mcp'), '.mcp-token');
    writeFileSync(path, 'stale\n');
    chmodSync(path, 0o644);

    persistToken(path, 'fresh');

    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readToken(path)).toBe('fresh');
  });

  it('answers null for a file that is missing or holds nothing', () => {
    const dir = tempDir('mcp');
    const missing = join(dir, 'absent');
    const blank = join(dir, 'blank');
    writeFileSync(blank, '   \n');

    expect(existsSync(missing)).toBe(false);
    expect(readToken(missing)).toBeNull();
    expect(readToken(blank)).toBeNull();
  });
});

describe('tokenMatches', () => {
  it('accepts the same token and refuses a different one', () => {
    const token = mintToken();

    expect(tokenMatches(token, token)).toBe(true);
    expect(tokenMatches(token, mintToken())).toBe(false);
  });

  it('survives a token of a different length instead of throwing', () => {
    // timingSafeEqual throws on unequal buffer lengths, and that throw would itself leak
    // the length of the expected token — hence the comparison over SHA-256 digests.
    expect(() => tokenMatches('short', 'a much longer guess than the real one')).not.toThrow();
    expect(tokenMatches('short', 'a much longer guess than the real one')).toBe(false);
  });

  it('refuses an empty guess', () => {
    expect(tokenMatches(mintToken(), '')).toBe(false);
  });
});

describe('bearerGuard', () => {
  const token = mintToken();
  const guard = () => bearerGuard(token);

  it('lets a request with the right token through', () => {
    const { passed, res } = call(guard(), `Bearer ${token}`);

    expect(passed).toBe(true);
    expect(res.statusCode).toBeNull();
  });

  it.each(['bearer', 'BEARER', 'BeArEr'])('accepts %s as the scheme, as RFC 6750 requires', (scheme) => {
    expect(call(guard(), `${scheme} ${token}`).passed).toBe(true);
  });

  it('tolerates the padding a hand-written client adds', () => {
    expect(call(guard(), `  Bearer   ${token}  `).passed).toBe(true);
  });

  it('answers 401 with a WWW-Authenticate header when no token was sent', () => {
    // The header is not decoration: it is what tells a client the endpoint wants a
    // bearer token rather than being broken.
    const { passed, res } = call(guard(), undefined);

    expect(passed).toBe(false);
    expect(res.statusCode).toBe(401);
    expect(res.headers['WWW-Authenticate']).toBe('Bearer realm="ambassy-mcp", error="invalid_token"');
    expect(res.body).toEqual({ error: 'unauthorized' });
  });

  it.each([
    ['a wrong token', `Bearer ${mintToken()}`],
    ['no scheme at all', 'just-the-token'],
    ['another scheme', 'Basic dXNlcjpwYXNz'],
    ['an empty header', ''],
  ])('refuses %s', (_label, header) => {
    const { passed, res } = call(guard(), header);

    expect(passed).toBe(false);
    expect(res.statusCode).toBe(401);
  });

  it('keeps the realm fixed, since it names a credential and not the agent', () => {
    // AGENT_NAME renames the agent in serverInfo and on the card; renaming it does not
    // mint a new token, so the realm stays put.
    const { res } = call(bearerGuard('another-token'), 'Bearer nope');

    expect(res.headers['WWW-Authenticate']).toContain('realm="ambassy-mcp"');
  });
});
