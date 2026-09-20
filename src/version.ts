/**
 * The project's version, read from package.json so the number lives in one place.
 *
 * This is what the Agent Card and the MCP `serverInfo` report, and it is the version of *this*
 * bridge rather than of the coding agent behind it. The distinction matters on the card: a caller
 * reading `version` is being told what it is talking to, which is Ambassy — the adapter's own
 * version is a fact about the thing doing the work, and rides in the description instead.
 */
import { readFileSync } from 'node:fs';

const manifest = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
) as { version: string };

export const VERSION = manifest.version;
