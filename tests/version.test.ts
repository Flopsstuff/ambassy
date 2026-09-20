/**
 * The card's `version` is Ambassy's own, read from package.json so the number lives in
 * one place. It used to be the adapter's, which made the bridge announce itself as
 * v0.79.0 — a caller reading `version` is being told what it is talking to.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { VERSION } from '../src/version.ts';

describe('VERSION', () => {
  it('is the version in package.json', () => {
    const manifest = JSON.parse(readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8')) as {
      version: string;
    };

    expect(VERSION).toBe(manifest.version);
  });

  it('looks like a version a client can compare', () => {
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+/);
  });
});
