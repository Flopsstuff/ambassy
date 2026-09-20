/**
 * The shared secret that guards the MCP endpoint, minted at startup.
 *
 * Hand-rolled rather than the SDK's `requireBearerAuth`, and the reason is worth
 * stating: that helper is built for OAuth access tokens — it runs a verifier,
 * enforces scopes, and rejects a token that carries no expiry or is past it. Ours
 * is a bootstrap secret with no issuer, no scopes and no expiry, so satisfying that
 * contract would mean minting a fake `expiresAt` and pretending to be an
 * authorization server. A constant-time comparison says what we actually mean.
 *
 * The comparison is over SHA-256 digests rather than the raw strings, because
 * `timingSafeEqual` throws when the buffers differ in length — and that throw would
 * itself leak the length of the expected token.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import type { NextFunction, Request, Response } from 'express';

/** 32 bytes, base64url: 43 characters, no escaping needed in a shell or a JSON config. */
export const mintToken = (): string => randomBytes(32).toString('base64url');

/**
 * Writes the token where the operator can read it back.
 *
 * `writeFileSync`'s mode applies only when it creates the file, so an existing file
 * keeps whatever permissions it had. `chmodSync` afterwards makes the result the same
 * either way.
 */
export const persistToken = (path: string, token: string): void => {
  writeFileSync(path, `${token}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
};

export const readToken = (path: string): string | null =>
  existsSync(path) ? readFileSync(path, 'utf8').trim() || null : null;

const digest = (value: string): Buffer => createHash('sha256').update(value).digest();

export const tokenMatches = (expected: string, given: string): boolean =>
  timingSafeEqual(digest(expected), digest(given));

/** `Authorization: Bearer <token>`, case-insensitive on the scheme as RFC 6750 requires. */
const bearerFrom = (header: string | undefined): string | null => {
  if (!header) return null;
  const match = /^bearer\s+(.+)$/i.exec(header.trim());
  return match ? match[1].trim() : null;
};

// --- the guard itself ---

/**
 * Refuses anything without the token before the MCP handler sees it.
 *
 * `WWW-Authenticate` is not decoration: it is what tells a client the endpoint wants
 * a bearer token rather than being broken.
 *
 * Its realm stays `ambassy-mcp` and does not follow `AGENT_NAME`: a realm names the set of
 * credentials that open this endpoint, and renaming the agent does not mint a new token.
 */
export const bearerGuard =
  (expected: string) =>
  (req: Request, res: Response, next: NextFunction): void => {
    const given = bearerFrom(req.headers.authorization);
    if (given !== null && tokenMatches(expected, given)) {
      next();
      return;
    }
    console.log(`  ⨯ ${req.method} ${req.originalUrl} — ${given === null ? 'no bearer token' : 'bad token'}`);
    res
      .status(401)
      .set('WWW-Authenticate', 'Bearer realm="ambassy-mcp", error="invalid_token"')
      .json({ error: 'unauthorized' });
  };
