# Changelog

Notable changes, newest first. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the numbers follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Entries say what changed and, where the reason is not obvious from the change, why — this
repository exists to be read, and a list of verbs is no use to whoever comes next. Findings
referenced as `F01`, `F09` and so on are from [docs/repository-audit.md](docs/repository-audit.md),
which records them in full along with the evidence.

## [0.1.0] — 2026-09-21

The first version worth a number, and an honest one: tasks live in an `InMemoryTaskStore`, the
A2A side runs `UserBuilder.noAuthentication`, and the permission classifier is a placeholder for
an external channel — a human, a policy, or a supervising agent.

### Added

- **An A2A v1.0 server and client** (`src/agent.ts`, `src/client.ts`) — Agent Card discovery,
  streaming, `INPUT_REQUIRED` and the artifact cycle, with a placeholder executor (the "Revisor")
  that computes text statistics and nothing else.
- **The same protocol over bare curl** (`src/raw.sh`) and **a wire-tap** (`src/proxy.ts`) that
  prints raw JSON-RPC and SSE frames, because the SDK surfaces parsed objects and what you need to
  see is the wire.
- **The ACP bridge** (`src/acp/`) — the same A2A server with its executor replaced by a real
  coding agent addressed over stdin/stdout: one adapter process per `contextId`, a permission
  classifier that answers instead of the calling agent, and two rotating JSON Lines logs.
- **The MCP bridge** (`src/mcp/`) — the A2A agent published to a calling agent as four tools over
  Streamable HTTP, bearer-guarded, with progress ticks derived from upstream liveness.
  `a2a_ask` takes a `taskId` as well as a `contextId`, which is the only way to answer an
  `INPUT_REQUIRED` question rather than open a second task beside it, and every call reports the
  task and context it reached so an interrupted one can still be recovered (`F09`, `F10`).
- **Deadlines on everything that does not stream.** The silence gate covers `a2a_ask`;
  `MCP_DISCOVERY_TIMEOUT_MS` (20 s) bounds the shared agent handshake and
  `MCP_REQUEST_TIMEOUT_MS` (30 s) bounds `a2a_task`, `a2a_cancel` and `a2a_card`. Discovery is
  bounded separately because it is shared: a caller's abort ends only its own wait, while the
  deadline ends the handshake for everyone (`F11`).
- **`bin/ambassyctl`** — both processes installed and driven as background services, LaunchAgents
  on macOS and `systemd --user` units on Linux.
- **`docs/`** — architecture, both protocols, the permission model, configuration, logging,
  testing, troubleshooting, and the repository audit, published to GitHub Pages by
  `.github/workflows/docs.yml` through the same Jekyll that Pages runs anyway.
- **A test suite** — `yarn test` runs 288 vitest cases over the paths that are hard to provoke by
  hand: a cancel that arrives before the session exists, a log that rotates mid-record, a stream
  that stops before its task reaches a state. Nothing is mocked at the module level; every
  substitution goes through an argument, so the seams stay visible in the production code.
  [docs/testing.md](docs/testing.md) says what they reach and what they leave alone.
- **`yarn typecheck` and CI.** There is no build step, so nothing checked types unless asked; the
  script carries the compiler flags in place of the `tsconfig.json` this repository deliberately
  lacks, and `.github/workflows/ci.yml` runs it with the tests on every push and pull request.

### Fixed

Found by the repository audit and closed before this version went out.

- **Artifacts aggregate instead of concatenating (`F12`).** Two replacements of one artifact,
  `old` then `new`, produced `oldnew`, and artifacts that were never the same artifact merged.
  They are now keyed by `artifactId`, honour `append`, are seeded from the task snapshot, and keep
  every data part.
- **A stream that loses its ending is an error (`F13`).** One that died mid-turn came back as a
  tidy result saying the agent "finished in `TASK_STATE_WORKING`". A turn now reports an outcome —
  `task`, `message`, `interrupted` or `truncated` — as well as a state.
- **The agent's last word survives (`F14`).** A refusal from the ACP bridge travels in a status
  message and nowhere else, and it was dropped for everything but `INPUT_REQUIRED`. It is kept now
  and reported by `a2a_ask` and `a2a_task`; `a2a_cancel` renders like a read rather than discarding
  what the task had already produced.
- **Leaving plan mode is not a refusal.** The `switch_mode` rule denied Claude's `ExitPlanMode`,
  which the adapter turns into an interrupt and reports as a cancellation — so a task that planned
  before acting would have died as it was ready to start. The destination is in the option ids,
  never in `rawInput`, and is read from an explicit table of both adapters' effects.
- **A deadline that is not a number falls back.** `Number(process.env.…)` of a typo is `NaN`, and
  `AbortSignal.timeout(NaN)` throws rather than ignoring it, which took out every call the
  deadline was meant to protect.
- **`..notes` is a filename (`F22`).** The containment check refused any relative path beginning
  with two dots, which is a climb out only when the next character is a separator.
- **17 type errors in running code.** Found by the new type check: stream payload fields read as
  though a protobuf message field were ever required, an exhausted union asked for its `$case`,
  adapters declared with three pipes and spawned with two.
- **`ACP_CWD` must be a directory**, not merely a path that exists.

### Security

- **A conversation's sandbox is not named after the caller (`F01`).** The A2A `contextId` is text
  the caller chooses, and joining it onto `.acp-sandboxes/` made `contextId: ".."` resolve to the
  repository root — returned as `owned: true`, the flag that lets the classifier pass `execute`
  and `fetch`. Directories come from `mkdtemp`, which fails unless the directory is new, with an
  explicit context-to-directory map and a containment check on reuse.
- **A session that cannot be supervised is not used (`F08`).** When the supervised mode was
  unavailable, the bridge logged the miss and carried on in whatever mode the adapter chose — for
  both backends, one where it approves its own tool calls. It now fails the session and disposes
  the half-started adapter. `switch_mode` is its own classifier case, decided on the option the
  adapter offered rather than on who owns the directory.
- **The wire-tap binds loopback (`F02`).** It called `listen(PORT)` with no host, which opened a
  wider door than the unauthenticated agent it fronts. It reads `HOST` now, like the two servers.

[0.1.0]: https://github.com/Flopsstuff/ambassy/commits/main
