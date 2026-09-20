/**
 * Where a conversation is allowed to work, and who decided that.
 *
 * `Boundary.owned` is the whole trust model — it is the flag that lets a shell run — so
 * it is asserted rather than inferred: true only for a directory allocated here, by
 * `mkdtemp`, under a parent this process made.
 *
 * Separate from `client.ts` because the rules are worth reading and testing on their
 * own: acquiring an adapter spawns a subprocess, while deciding where to put it is
 * arithmetic over paths.
 */
import { existsSync, lstatSync, mkdirSync, mkdtempSync, realpathSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { insideRoot, type Boundary } from './permissions.ts';

/**
 * A context id reduced to something readable in a directory listing.
 *
 * Only a label. It names a sandbox for a human reading `.acp-sandboxes/`; it never
 * decides which directory a conversation gets, because the id is text the caller chose.
 */
export const label = (contextId: string): string => contextId.replace(/[^a-zA-Z0-9]/g, '').slice(0, 8) || 'ctx';

/** True when `target` is a real directory — not a symlink to one — inside `parent`. */
export const ownDirectory = (parent: string, target: string): boolean => {
  if (target === parent || !insideRoot(parent, target)) return false;
  try {
    return lstatSync(target).isDirectory();
  } catch {
    return false;
  }
};

/**
 * The disposable directories, one per conversation.
 *
 * A directory is never named after the `contextId`. That id arrives from the A2A caller,
 * and the parent's own parent is the repository root: a caller choosing `..` would have
 * the bridge mark its own checkout `owned: true`. `mkdtemp` sidesteps the question
 * entirely — it fails unless the directory is new, so two conversations cannot land in
 * one, and neither an existing directory nor a symlink wearing the right name can be
 * adopted as one this process created.
 *
 * The map outlives the adapter on purpose: a conversation that comes back after its
 * process was reaped finds the files its earlier turns left behind.
 */
export class Sandboxes {
  private readonly allocated = new Map<string, string>();

  constructor(private readonly dir: string) {}

  for(contextId: string): string {
    mkdirSync(this.dir, { recursive: true });
    // Resolved once, here: a path that reaches the agent through a symlink comes back
    // resolved, and a textual comparison would then deny the agent its own root.
    const parent = realpathSync(this.dir);

    const known = this.allocated.get(contextId);
    if (known && ownDirectory(parent, known)) return known;

    const root = realpathSync(mkdtempSync(join(parent, `${label(contextId)}-`)));
    if (!ownDirectory(parent, root)) throw new Error(`sandbox for ${contextId} escaped ${parent}: ${root}`);
    this.allocated.set(contextId, root);
    return root;
  }
}

export interface BoundaryOptions {
  /** ACP_CWD, if set. Empty means "make a sandbox per conversation". */
  cwdOverride: string;
  allowExecute: boolean;
}

/** The area one conversation is confined to, and how much it is trusted inside it. */
export const resolveBoundary = (
  { cwdOverride, allowExecute }: BoundaryOptions,
  contextId: string,
  sandboxes: Sandboxes,
): Boundary => {
  if (cwdOverride) {
    const root = resolve(cwdOverride);
    // Claude validates cwd on session/new — absolute, exists, is a directory — so a
    // bad ACP_CWD is worth catching here, where the message can say what to fix.
    if (!existsSync(root)) throw new Error(`ACP_CWD points at a path that does not exist: ${root}`);
    if (!statSync(root).isDirectory()) throw new Error(`ACP_CWD is not a directory: ${root}`);
    return { root: realpathSync(root), owned: false, allowExecute };
  }
  // Deliberately NOT under os.tmpdir(). Codex's sandbox counts /tmp and $TMPDIR as
  // writable and asks no one before writing there, so sandboxes placed in the temp tree
  // would be mutually reachable without a single permission request. Here each one sits
  // in its own directory whose only writable neighbour is itself.
  return { root: sandboxes.for(contextId), owned: true, allowExecute };
};
