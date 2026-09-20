/**
 * Permission classifier for the A2A → ACP bridge, plus the `fs/*` handlers.
 *
 * The calling A2A client is NOT a trusted party. If the agent that issued a task
 * also approves that task's actions, the check is theatre — and `INPUT_REQUIRED`
 * becomes a channel through which the called agent talks itself into more rights.
 * So the decision is made here, inside the bridge, and never travels upstream.
 *
 * This is a placeholder. The real answer is an external channel: a human, a
 * declarative policy, or a supervising agent. Everything below is deliberately
 * reachable through two exported functions, so that channel can replace it
 * without the rest of the bridge noticing.
 */
import { realpathSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import {
  RequestError,
  type PermissionOption,
  type PermissionOptionKind,
  type ReadTextFileRequest,
  type ReadTextFileResponse,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type ToolCallUpdate,
  type ToolKind,
  type WriteTextFileRequest,
  type WriteTextFileResponse,
} from '@agentclientprotocol/sdk';

/** The area the agent is confined to, and how much we trust it. */
export interface Boundary {
  /** Absolute path handed to `session/new` as `cwd`. */
  root: string;
  /** True when the bridge created this directory itself instead of being handed one. */
  owned: boolean;
  /** Escape hatch for shell and network when the root is not ours. Off by default. */
  allowExecute: boolean;
}

interface Verdict {
  allow: boolean;
  reason: string;
}

/**
 * Resolve a path through symlinks as far as it actually exists.
 *
 * Without this the check is wrong on macOS before it is ever attacked: `os.tmpdir()`
 * answers `/var/folders/…`, which is a symlink to `/private/var/folders/…`, and the
 * agent reports the resolved form. Comparing the two as text denies the agent its own
 * sandbox. The file being written usually does not exist yet, so we resolve the deepest
 * ancestor that does and re-attach the rest.
 */
const realise = (target: string): string => {
  let current = resolve(target);
  const tail: string[] = [];
  for (;;) {
    try {
      return join(realpathSync(current), ...[...tail].reverse());
    } catch {
      const parent = dirname(current);
      if (parent === current) return resolve(target);
      tail.push(basename(current));
      current = parent;
    }
  }
};

/**
 * A path is inside the boundary only if the route to it never climbs out.
 *
 * `root` is expected to be already resolved (acp-client.ts does that once, at creation).
 * Known limit of this stub: a symlink created inside the root *after* this check would
 * not be noticed — catching that needs a policy engine, not a switch statement.
 */
export const insideRoot = (root: string, target: string): boolean => {
  const rel = relative(root, realise(resolve(root, target)));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
};

const classify = (toolCall: ToolCallUpdate, boundary: Boundary): Verdict => {
  const kind: ToolKind = toolCall.kind ?? 'other';
  const locations = toolCall.locations ?? [];

  switch (kind) {
    case 'read':
    case 'search':
    case 'think':
      return { allow: true, reason: `${kind} changes nothing` };

    case 'edit':
    case 'delete':
    case 'move': {
      if (locations.length === 0) {
        // Nothing to check against. Permitted only where the agent's own cwd is a
        // directory we made, so the blast radius is something we own outright.
        return boundary.owned
          ? { allow: true, reason: `${kind} without locations, but the root is our own sandbox` }
          : { allow: false, reason: `${kind} without locations cannot be checked against ${boundary.root}` };
      }
      const escaping = locations.filter((l) => !insideRoot(boundary.root, l.path));
      return escaping.length === 0
        ? { allow: true, reason: `${kind} stays inside the root` }
        : { allow: false, reason: `${kind} escapes the root: ${escaping.map((l) => l.path).join(', ')}` };
    }

    default:
      // execute, fetch, switch_mode, other — effects we cannot inspect from a tool
      // call alone. The rule is one sentence long on purpose: a shell runs only in a
      // directory that belongs to us.
      if (boundary.owned) return { allow: true, reason: `${kind} allowed: the root is our own sandbox` };
      if (boundary.allowExecute) return { allow: true, reason: `${kind} allowed: ACP_ALLOW_EXECUTE is set` };
      return { allow: false, reason: `${kind} is unverifiable and the root was handed to us, not created by us` };
  }
};

/**
 * Options are chosen out of what the agent offered — never invented.
 *
 * The one refinement worth making: ACP has no kind meaning "abort the whole turn", so
 * Codex expresses that as an ordinary `reject_once` with the id `cancel`, sitting beside
 * a `decline` that only refuses the single tool and lets the agent carry on. Declining is
 * the better answer when it is on the table — a denied command should not kill the task.
 * On file edits Codex offers no `decline` at all, and then cancelling is the only refusal
 * there is.
 */
const pickOption = (options: PermissionOption[], allow: boolean): PermissionOption | undefined => {
  const wanted: PermissionOptionKind[] = allow
    ? ['allow_once', 'allow_always']
    : ['reject_once', 'reject_always'];
  for (const kind of wanted) {
    const matching = options.filter((o) => o.kind === kind);
    const gentle = matching.find((o) => o.optionId !== 'cancel');
    if (gentle ?? matching[0]) return gentle ?? matching[0];
  }
  return undefined;
};

export const decidePermission = (
  params: RequestPermissionRequest,
  boundary: Boundary,
  onDeny?: (summary: string) => void,
): RequestPermissionResponse => {
  const verdict = classify(params.toolCall, boundary);
  const title = params.toolCall.title ?? params.toolCall.toolCallId;
  const kind = params.toolCall.kind ?? 'other';
  const option = pickOption(params.options, verdict.allow);

  if (!option) {
    // Answering with an id the agent never offered is the one thing we must not do:
    // Claude fails the whole turn with "Permission option was not offered", and Codex
    // silently downgrades it to a cancel, so the tool dies with nothing in the log.
    console.log(`  🔒 «${title}» (${kind}) → cancelled — no ${verdict.allow ? 'allow' : 'reject'} option was offered`);
    onDeny?.(`${title}: ${verdict.reason}`);
    return { outcome: { outcome: 'cancelled' } };
  }

  console.log(`  🔒 «${title}» (${kind}) → ${verdict.allow ? 'allow' : 'deny'} [${option.optionId}] — ${verdict.reason}`);
  if (!verdict.allow) onDeny?.(`${title}: ${verdict.reason}`);
  return { outcome: { outcome: 'selected', optionId: option.optionId } };
};

// --- fs/* : we advertise these capabilities on purpose ---
//
// Declaring `fs.readTextFile` / `fs.writeTextFile` makes the agent route file access
// through us instead of touching the disk behind our back. Every read and write then
// passes the boundary check and lands in the log.

const guardPath = (path: string, boundary: Boundary): string => {
  if (!insideRoot(boundary.root, path)) {
    throw RequestError.invalidParams(undefined, `path escapes the session root ${boundary.root}: ${path}`);
  }
  return resolve(boundary.root, path);
};

const shortPath = (target: string, boundary: Boundary): string => relative(boundary.root, target) || '.';

export const readTextFileInsideRoot = async (
  params: ReadTextFileRequest,
  boundary: Boundary,
): Promise<ReadTextFileResponse> => {
  const target = guardPath(params.path, boundary);
  const whole = await readFile(target, 'utf8');
  console.log(`  📄 read ${shortPath(target, boundary)}`);

  if (params.line == null && params.limit == null) return { content: whole };

  const lines = whole.split('\n');
  const from = Math.max(0, (params.line ?? 1) - 1);
  const slice = params.limit == null ? lines.slice(from) : lines.slice(from, from + params.limit);
  return { content: slice.join('\n') };
};

export const writeTextFileInsideRoot = async (
  params: WriteTextFileRequest,
  boundary: Boundary,
): Promise<WriteTextFileResponse> => {
  const target = guardPath(params.path, boundary);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, params.content, 'utf8');
  console.log(`  📝 wrote ${shortPath(target, boundary)} (${params.content.length} chars)`);
  return {};
};
