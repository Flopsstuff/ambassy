/**
 * Where a conversation is allowed to work — the decision that `Boundary.owned` records,
 * and the one that lets a shell run at all.
 *
 * The caller chooses the `contextId`, so these tests are mostly about what happens when
 * that id is chosen adversarially, and about the directory never being adopted rather
 * than created.
 */
import { existsSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Sandboxes, label, ownDirectory, resolveBoundary } from '../../src/acp/sandbox.ts';
import { tempDir } from '../helpers/tmp.ts';

describe('label', () => {
  it('keeps the first eight alphanumeric characters of an id', () => {
    expect(label('3f2a9b1c-dead-beef-0000-111122223333')).toBe('3f2a9b1c');
  });

  it('strips everything that is not alphanumeric', () => {
    expect(label('../../etc/passwd')).toBe('etcpassw');
  });

  it('falls back to a fixed word when nothing is left', () => {
    expect(label('../..')).toBe('ctx');
    expect(label('')).toBe('ctx');
  });
});

describe('ownDirectory', () => {
  it('accepts a real directory inside the parent', () => {
    const parent = tempDir('parent');
    mkdirSync(join(parent, 'child'));

    expect(ownDirectory(parent, join(parent, 'child'))).toBe(true);
  });

  it('refuses the parent itself', () => {
    const parent = tempDir('parent');

    expect(ownDirectory(parent, parent)).toBe(false);
  });

  it('refuses a symlink, even one pointing at a directory inside the parent', () => {
    // lstat, not stat: a symlink wearing the right name is not a directory we made.
    const parent = tempDir('parent');
    mkdirSync(join(parent, 'real'));
    symlinkSync(join(parent, 'real'), join(parent, 'alias'));

    expect(ownDirectory(parent, join(parent, 'alias'))).toBe(false);
  });

  it('refuses a file, something outside, and something that is not there', () => {
    const parent = tempDir('parent');
    const outside = tempDir('outside');
    writeFileSync(join(parent, 'file.txt'), 'x');

    expect(ownDirectory(parent, join(parent, 'file.txt'))).toBe(false);
    expect(ownDirectory(parent, outside)).toBe(false);
    expect(ownDirectory(parent, join(parent, 'never-created'))).toBe(false);
  });
});

describe('Sandboxes', () => {
  it('creates the parent directory if it is not there yet', () => {
    const dir = join(tempDir('acp'), 'sandboxes');
    expect(existsSync(dir)).toBe(false);

    const root = new Sandboxes(dir).for('ctx-1');

    expect(existsSync(root)).toBe(true);
    expect(dirname(root)).toBe(dir);
  });

  it('names the directory after the id without letting the id choose it', () => {
    const dir = tempDir('acp');

    const root = new Sandboxes(dir).for('3f2a9b1c-dead-beef');

    // mkdtemp appends randomness, so the label is a hint for a human, not an address.
    expect(basename(root)).toMatch(/^3f2a9b1c-[A-Za-z0-9]{6}$/);
  });

  it('hands the same conversation the same directory twice', () => {
    const sandboxes = new Sandboxes(tempDir('acp'));

    expect(sandboxes.for('ctx-1')).toBe(sandboxes.for('ctx-1'));
  });

  it('gives two conversations two directories', () => {
    const sandboxes = new Sandboxes(tempDir('acp'));

    expect(sandboxes.for('ctx-1')).not.toBe(sandboxes.for('ctx-2'));
  });

  it('allocates a fresh one when the remembered directory has gone', () => {
    const sandboxes = new Sandboxes(tempDir('acp'));
    const first = sandboxes.for('ctx-1');
    rmSync(first, { recursive: true, force: true });

    const second = sandboxes.for('ctx-1');

    expect(second).not.toBe(first);
    expect(existsSync(second)).toBe(true);
  });

  it.each(['../..', '../../escape', '/etc', '.', ''])(
    'keeps a sandbox inside its parent however the id is spelled (%s)',
    (contextId) => {
      // The id comes from the A2A caller, and the parent's own parent is the repository
      // root: a directory named after `..` would mark the checkout `owned: true`.
      const dir = tempDir('acp');

      const root = new Sandboxes(dir).for(contextId);

      expect(dirname(root)).toBe(dir);
    },
  );

  it('never adopts a directory that was already there under the right name', () => {
    // mkdtemp fails unless the directory is new, which is the guarantee being relied on.
    const dir = tempDir('acp');
    mkdirSync(join(dir, 'ctx-planted'));

    const root = new Sandboxes(dir).for('ctx');

    expect(root).not.toBe(join(dir, 'ctx-planted'));
  });
});

describe('resolveBoundary', () => {
  const sandboxes = () => new Sandboxes(tempDir('acp'));

  it('marks a sandbox it made as ours', () => {
    const boundary = resolveBoundary({ cwdOverride: '', allowExecute: false }, 'ctx-1', sandboxes());

    expect(boundary.owned).toBe(true);
    expect(existsSync(boundary.root)).toBe(true);
  });

  it('marks a directory it was handed as not ours', () => {
    // ACP_CWD is someone else's directory; a shell must not run there by default.
    const given = tempDir('given');

    const boundary = resolveBoundary({ cwdOverride: given, allowExecute: false }, 'ctx-1', sandboxes());

    expect(boundary).toMatchObject({ root: given, owned: false, allowExecute: false });
  });

  it('carries the execute escape hatch through either way', () => {
    const given = tempDir('given');

    expect(resolveBoundary({ cwdOverride: given, allowExecute: true }, 'c', sandboxes()).allowExecute).toBe(true);
    expect(resolveBoundary({ cwdOverride: '', allowExecute: true }, 'c', sandboxes()).allowExecute).toBe(true);
  });

  it('resolves a relative ACP_CWD against the process, not the sandbox tree', () => {
    const boundary = resolveBoundary({ cwdOverride: '.', allowExecute: false }, 'ctx-1', sandboxes());

    expect(boundary.root).toBe(process.cwd());
  });

  it('resolves the root through symlinks once, here', () => {
    // The agent reports resolved paths; comparing an unresolved root against them would
    // deny it its own cwd.
    const real = tempDir('real');
    const link = join(tempDir('links'), 'alias');
    symlinkSync(real, link);

    expect(resolveBoundary({ cwdOverride: link, allowExecute: false }, 'ctx-1', sandboxes()).root).toBe(real);
  });

  it('says what to fix when ACP_CWD points nowhere', () => {
    // Claude validates cwd on session/new; catching it here makes the message useful.
    expect(() => resolveBoundary({ cwdOverride: '/no/such/place', allowExecute: false }, 'c', sandboxes())).toThrow(
      /ACP_CWD points at a path that does not exist/,
    );
  });

  it('says what to fix when ACP_CWD is a file', () => {
    const file = join(tempDir('given'), 'notes.md');
    writeFileSync(file, 'x');

    expect(() => resolveBoundary({ cwdOverride: file, allowExecute: false }, 'c', sandboxes())).toThrow(
      /ACP_CWD is not a directory/,
    );
  });
});
