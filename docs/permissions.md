# Permissions

## Why the caller is not asked

The obvious design is to forward the agent's permission request upstream as an A2A
`INPUT_REQUIRED` and let the calling client decide. The bridge deliberately does not do this.

The caller is the party that wants the work done. An agent that approves the actions of the task
it itself issued is not being checked — the approval is a formality, and `INPUT_REQUIRED` becomes
a channel through which the called agent talks itself into more rights. A permission decision
needs a party whose interests differ from the requester's: a human, a declarative policy, or a
supervising agent that is not the one asking.

None of those exist here yet. What exists is a classifier inside the bridge — a placeholder,
deliberately reachable through two exported functions in `src/acp/permissions.ts`, so a real
external channel can replace it without the rest of the bridge noticing. **This is the main open
question in the project.**

## The boundary

Every session has a root directory and one bit saying where it came from:

```ts
interface Boundary {
  root: string;        // absolute, symlinks already resolved
  owned: boolean;      // true when the bridge created this directory itself
  allowExecute: boolean;
}
```

`owned` is the whole trust model in one flag. A directory the bridge created is empty and
disposable; a directory handed to it through `ACP_CWD` may contain anything, including the
repository itself.

Which is why the flag is asserted rather than inferred, and why a sandbox is never named after the
conversation it belongs to. The `contextId` is text an A2A caller chose: with the directory built
by joining it onto `.acp-sandboxes/`, a context called `..` resolved to the repository root and
came back marked `owned: true` — the bridge would have handed a shell its own checkout. Sandboxes
are allocated with `mkdtemp` instead, which fails unless the directory is new, so two conversations
cannot land in one and neither an existing directory nor a symlink wearing the right name can be
adopted as one the bridge made. The context id survives as a label on the front of the name, for
whoever reads a directory listing, and the registry remembers which conversation owns which
directory. `ACP_CWD` is checked the same way: it has to be a directory, not merely a path that
exists.

## The rules

| Tool kind | Decision |
|---|---|
| `read`, `search`, `think` | allow — nothing changes |
| `edit`, `delete`, `move` with locations | allow if every path resolves inside the root |
| `edit`, `delete`, `move` without locations | allow only if the root is ours — there is nothing to check |
| `switch_mode` | allow only the offered option that keeps supervision — owning the directory grants nothing here |
| `execute`, `fetch`, `other` | allow only if the root is ours, or `ACP_ALLOW_EXECUTE=true` |

One sentence covers the last row: **a shell runs only in a directory that belongs to us.** The
effects of a command cannot be read off the tool call, so the containment has to come from the
directory rather than from inspection.

`switch_mode` is the exception to that sentence, and it sits in its own row for a reason. The
session mode is what makes the adapter ask at all, so a call proposing to leave it is a call
asking for the classifier to be switched off — owning the directory says nothing about that.

Where the destination is is the part worth knowing. Both adapters ask this question when a plan
ends, and neither puts the mode in `rawInput` — that carries the plan text. The destination is in
the *option ids*, so the answer is a choice among them rather than a yes or a no:

| Option | Adapter | Lands in |
|---|---|---|
| `exit-plan-default` | Claude | `default` — leaves planning, still asks about every call |
| `exit-plan-accept-edits`, `exit-plan-auto`, `exit-plan-bypass` | Claude | an elevated mode |
| `exit-plan-clear-*` | Claude | an elevated mode, and a fresh context |
| `implement_plan` | Codex | nothing — plan review changes no mode either way |

The table is explicit rather than pattern-matched, because it is read off the adapters' own effect
tables (`dist/permissions/effects.js`, `src/permissions/plan-review.ts`) and an option whose
behaviour is unverified is refused.

Refusing outright is not the safe default it looks like: both adapters treat a refusal here as an
instruction to stop, and Claude's ends the ACP turn — the adapter maps that intentional stop back
to a cancellation, so a task that merely planned first would die on the way to doing the work.

Path containment resolves symlinks as far as the path exists. Without that the check is wrong
before it is ever attacked: on macOS `os.tmpdir()` answers `/var/folders/…`, a symlink to
`/private/var/folders/…`, and the agent reports the resolved form — comparing the two as text
denies the agent its own sandbox.

## Answering correctly

The reply is never the word "allow". It is an `optionId` **taken from the list the agent just
offered**, chosen by its `kind` (`allow_once`, then `allow_always`; `reject_once`, then
`reject_always`). Inventing an id is the one thing that must not happen, and the two backends fail
differently when it does:

- Claude throws `Permission option was not offered: …` and the whole turn dies;
- Codex silently downgrades it to a cancel, so the tool is refused with nothing in the log.

One refinement: ACP has no kind meaning "abort the whole turn", so Codex expresses that as an
ordinary `reject_once` with the id `cancel`, sitting beside a `decline` that refuses only the one
tool and lets the agent carry on. Declining is the better answer when it is offered — a denied
command should not kill the task. On file edits Codex offers no `decline` at all, and then
cancelling is the only refusal available, which is why a denied edit ends the task as `CANCELED`.

Every refusal is recorded and travels back to the A2A client, either in the `CANCELED` status
message or in the note attached to `COMPLETED`, so the caller learns *why* without reading server
logs.

## What this does not protect against

Worth stating plainly, because the classifier looks stronger than it is.

**The bridge only sees what the adapter chooses to ask about.** It supervises the decisions that
reach it; it is not a sandbox. Claude Code's own allowlist passes safe commands like `ls` without
asking, and those never reach the classifier.

**Codex keeps `/tmp` and `$TMPDIR` writable without asking.** Its sandbox policy is hardcoded per
mode inside the adapter and resent on every turn, so nothing on the client side narrows it —
`CODEX_CONFIG` was tried and has no effect on it. This is why sandboxes are created under
`.acp-sandboxes/` in the repository rather than in the temp tree: otherwise two conversations
could write into each other's directories without a single permission request.

**Symlinks planted inside the root after the check are not followed.** Paths are resolved once,
which is enough for `/var` against `/private/var` but not against an adversary.

**With `ACP_CWD` set, all conversations share one root.** Isolation by process and session
remains; isolation by directory does not.
