# AGENTS.md

Guidance for AI coding agents working in this repository.
`CLAUDE.md` and `GEMINI.md` are symlinks to this file.

## What this is

A learning sandbox for the **A2A Protocol v1.0** (Agent2Agent), built on `@a2a-js/sdk`.
Not production: tasks live in an `InMemoryTaskStore`, there is no authentication
(`UserBuilder.noAuthentication`), and the agent returns placeholder text statistics. The value of
this repo is in demonstrating protocol mechanics, so changes should preserve legibility —
explicit steps, readable logs, and comments explaining why the protocol demands a given shape.

## Commands

```bash
yarn agent         # A2A server on :41241 (must be running for client and raw)
yarn agent:claude  # the same A2A server, but a real coding agent behind it (ACP bridge)
yarn agent:codex   # ditto, with Codex instead of Claude
yarn client        # SDK client: two-turn conversation with streaming
yarn raw           # the same protocol over bare curl, no SDK
yarn tap           # wire-tap proxy :41242 → :41241
yarn mcp           # MCP endpoint on :41243 fronting the A2A agent, for a calling agent
yarn service       # install and drive the whole thing as a background service
```

All three servers listen on the same port and serve the same protocol, so `client`, `raw` and
`tap` work against any of them without a change. They bind `127.0.0.1` by default: an A2A server
here runs `UserBuilder.noAuthentication`, so a wider bind hands a coding agent to the network with
nothing in front of it. `HOST` selects the interface, and `HOST=0.0.0.0` opens one up deliberately.
The MCP bridge is the side meant to face a network, and it has a bearer token (`MCP_HOST`).

To inspect raw traffic (three terminals):

```bash
PUBLIC_URL=http://localhost:41242/ yarn agent   # agent advertises the tap's address in its card
yarn tap
AGENT_URL=http://localhost:41242 yarn client
```

`PUBLIC_URL` is what a client dials: it reads `supportedInterfaces[].url` from the Agent Card
rather than remembering where it fetched the card, so without the substitution above it connects
directly and bypasses the proxy. The same rule binds `PUBLIC_URL` to `HOST` — it defaults to
`http://$HOST:$PORT/`, and moving `HOST` without it leaves the card advertising an address the
caller cannot reach.

Two things about `.env`, both verified rather than assumed: a shell variable wins over the file,
because `process.loadEnvFile` does not overwrite a key already in the environment; and a blank
value means unset, because these are read with `||` rather than `??` — `LOG_DIR=`, a line once
shipped in `.env.example`, otherwise reached `mkdirSync('')` and killed the server before it
listened. `ACP_CWD`, `A2A_AGENTS`, `MCP_ALLOWED_HOSTS` and `MCP_TOKEN` keep `??`, because there
blank is a real answer.

The card's `version` is Ambassy's own, read from `package.json` through `src/version.ts` so the
number lives in one place. It used to be the adapter's, which made the bridge announce itself as
v0.79.0; the adapter's name and version are in the card's `description` instead, because `version`
tells a caller what it is talking to and the description tells it what is behind that.

`AGENT_NAME` names the agent to callers in both places one looks: the Agent Card's `name` and the
MCP `serverInfo`. Blank keeps `Claude (via ACP)` / `Codex (via ACP)`, `Revisor` and `ambassy-mcp`.
On the card it replaces the default outright — `(via ACP)` separates no two instances, and the
backend stays named in the description and the skill tags. Not followed by the bearer realm, which
names a credential, nor by the ACP client name, which points the other way.

## Package manager

**Yarn 4 (Berry)**, pinned by the `packageManager` field in `package.json`; Corepack resolves that
version on its own, so a fresh checkout needs nothing but `yarn install`. The lockfile is
`yarn.lock` — there is no `package-lock.json` any more, and mixing the two managers in one clone
will silently produce a different dependency tree.

Three things in `.yarnrc.yml` and in Yarn's own defaults are deliberate:

- `nodeLinker: node-modules` — **not** the default Plug'n'Play. `tsx` resolves imports through its
  own esbuild loader, which cannot read a PnP map, so under PnP every `yarn agent` / `yarn client`
  would die on `import ... from '@a2a-js/sdk'`.
- `enableGlobalCache: true` — the package cache lives outside the repository, so `.yarn/cache`
  never grows into something that has to be gitignored file by file.
- Yarn refuses versions published less than 24 hours ago (`npmMinimalAgeGate`, 1440 minutes) and
  runs no install scripts unless a package is allowlisted. Both are supply-chain defaults; if an
  install fails with `All versions satisfying ... are quarantined`, the version is simply too
  fresh — wait it out or relax the range, rather than turning the gate off.

There is no build step — `tsx` executes TypeScript directly, and the absence of `tsconfig.json`
is deliberate. There are no tests and no linter either; `yarn test` is the stub left by `npm init`.
The way to verify things still work is to run `yarn client` against a live agent and check the
expected cycle: `SUBMITTED → INPUT_REQUIRED → WORKING → artifact → COMPLETED`.

## Architecture

The server side (`src/agent.ts`) is three SDK layers that must not be conflated:

1. **`AgentExecutor`** (`RevisorExecutor`) — business logic. It returns nothing; it publishes
   events to an `ExecutionEventBus` via `AgentEvent.task()` / `.statusUpdate()` / `.artifactUpdate()`.
2. **`DefaultRequestHandler`** — routing, task storage, cancellation, push notifications.
3. **Transport adapter** — `jsonRpcHandler` from `@a2a-js/sdk/server/express`. The Agent Card is
   served separately by `agentCardHandler` at `AGENT_CARD_PATH` (`.well-known/agent-card.json`).

A single `DefaultRequestHandler` can be mounted on several transports at once (JSON-RPC, REST, gRPC).

The client (`src/client.ts`) hardcodes neither a method URL nor a protocol:
`ClientFactory.createFromUrl()` downloads the card and picks a transport from `supportedInterfaces`.
The stream is consumed as an async generator, `client.sendMessageStream(...)`.

`src/proxy.ts` is a hand-written `node:http` proxy, not part of the SDK. It exists because the SDK
surfaces already-parsed objects, and what you need to see is the wire.

## The ACP bridge

`src/acp/agent.ts` is the same A2A server with `RevisorExecutor` swapped for one that forwards the
task to a real coding agent. Downstream it speaks **ACP** — the mirror image of A2A: the agent is
a child process addressed over stdin/stdout in newline-delimited JSON-RPC, and the bridge plays
the role an editor plays. Three files: `src/acp/client.ts` (processes and sessions),
`src/acp/permissions.ts` (the permission classifier and the `fs/*` handlers), `src/acp/agent.ts` (the
A2A side and the translation). The backend comes from `ACP_AGENT`, set by the launch script;
everything else comes from `.env` (see `.env.example`).

**One adapter process per A2A `contextId`.** Conversations are isolated by process, a task
continued after `INPUT_REQUIRED` lands in the same ACP session and the agent remembers the first
turn, and a conversation that goes quiet has its process reaped. A task still open — including one
parked in `INPUT_REQUIRED` — keeps its adapter alive, because the alternative is a follow-up
silently arriving in a session with no memory of the question it answers.

The event translation, which is the point of the exercise:

| ACP | A2A |
|---|---|
| — | `AgentEvent.task()` first, always |
| `agent_message_chunk` | `WORKING` + text, coalesced; collected for the artifact |
| `agent_thought_chunk` | `WORKING`, marked as thinking |
| `tool_call` / `tool_call_update` | `WORKING`, and only on a status change for updates |
| `plan` | `WORKING`, the entries as a list |
| `stop: end_turn` | `artifactUpdate` (`acp-answer`) + `COMPLETED` |
| `stop: cancelled` | `CANCELED`, carrying the refusal reason when the classifier caused it |
| `stop: refusal` | `FAILED` |
| `stop: max_tokens` / `max_turn_requests` | `COMPLETED`, the reason in the data part |

Chunks are coalesced on purpose: Codex streams one token per update, and forwarding those
verbatim buries the wire under hundreds of single-word SSE frames.

### Cancellation

`CancelTask` has a stricter contract than it looks
(`@a2a-js/sdk/dist/server/index.js`, `cancelTask`): the handler calls `executor.cancelTask`,
then drains the event bus until the task is terminal, and finally **requires the stored state to
be `CANCELED`**. Anything else — including a perfectly normal `COMPLETED` — comes back to the
caller as `-32002 TASK_NOT_CANCELABLE`. So an executor that merely forwards the cancel and lets
the turn finish looks broken from outside.

Two things follow, and the bridge does both:

- **A cancel can arrive before there is a session to cancel.** The first event must be `task`,
  which is published before the adapter is acquired, so a client that reacts to that first frame
  gets in while `spawn` + `initialize` + `session/new` are still running — several seconds.
  `cancelTask` therefore records the task id as well as sending the notification, and `execute`
  checks that flag after acquiring the runtime and stops before prompting.
- **An ACP turn may end `end_turn` despite the cancel.** The bridge publishes the artifact anyway
  and then reports `CANCELED`, because the client asked to cancel a task that was still running
  and is owed that answer.

In ACP the cancel itself is a notification, not a request: `session/cancel` is sent, the updates
keep arriving, and the turn closes with `stopReason: 'cancelled'`.

### Logging

Two files under `logs/`, JSON Lines, rotated by size (`src/acp/log.ts`). Written by hand for the
same reason `src/proxy.ts` is: appending a line, counting bytes and renaming files is the whole
job, and a logging library would hide it behind transports without making it more correct. The
format is structured because half of what is recorded is — token counts, tool-call records, the
paths a permission decision turned on — and prose would force the reader to parse English back
into numbers. A failed write is reported once to stderr and then swallowed: logging must not be
able to take the bridge down.

`calls.jsonl` — the outward boundary and what it costs:

| event | carries |
|---|---|
| `handshake`, `handshake.failed` | the startup probe: agent name and version, protocol version, auth methods |
| `adapter.spawn` | pid, backend, cwd, whether the root is ours |
| `session.new` | session id, cwd, the mode settled on, how long it took |
| `task.start`, `task.input_required` | the A2A side, for correlation |
| `prompt.start`, `prompt.stop` | duration, `stopReason`, tool counts, refusals, **`usage` and the running `budget`** |
| `task.cancel`, `task.failed`, `task.finish` | how the task ended, with the budget |
| `adapter.exit`, `adapter.reap` | exit code or idle time, and the conversation's final budget |

`work.jsonl` — what happened inside a turn: `tool.call`, `tool.update`, `plan`, `permission`
(decision, the reason, the paths, and which options the agent offered), `fs.read`, `fs.write`,
`fs.denied`.

Every record carries `ts` and `event`; work records also carry `contextId`, `taskId` and
`sessionId`, so a permission decision can be traced back to the task that provoked it. The
`taskId` comes from state the runtime keeps for the turn in flight, which is sound only because
`Runtime.run` allows one turn per conversation at a time.

`usage` is the cost of one turn; `budget` is the conversation's running total, since a
conversation is several turns and only the total says what it cost. Rotation happens **before**
a write, never after — a record split across two files is a record no reader can parse.

Knobs: `LOG_DIR` (default `logs/` beside the repository root), `LOG_MAX_BYTES` (5 MB),
`LOG_MAX_FILES` (5, the live file included). `logs/` is gitignored.

### Permissions

The calling A2A client is **not** a trusted party. An agent that approves the actions of the task
it itself issued is not a check, and routing the question back as `INPUT_REQUIRED` would turn a
protocol state into a way for the called agent to talk itself into more rights. So the decision is
made inside the bridge, by the classifier in `src/acp/permissions.ts`, and never travels upstream.
That classifier is a placeholder for an external channel — a human, a policy, or a supervising
agent — which is why it is one function behind one export.

Its rules: read/search/think pass; edit/delete/move pass only if every path is inside the session
root; execute/fetch/other pass only when the root is a directory the bridge created itself. The
answer must be an `optionId` **from the list the agent offered** — inventing one makes Claude fail
the whole turn with `Permission option was not offered`, and makes Codex silently downgrade it to
a cancel.

**A sandbox is never named after the conversation.** `contextId` is text the A2A caller chose, and
joining it onto `.acp-sandboxes/` made `..` resolve to the repository root — returned `owned: true`,
which is the flag that lets a shell run. Directories come from `mkdtemp`, which fails unless the
directory is new, so an existing directory or a symlink wearing the right name cannot be adopted as
one the bridge made, and two contexts sharing eight characters cannot merge. The id stays as a
label on the front of the name, and the registry keeps the context-to-directory map.

The bridge also sets the session mode, rather than leaving it alone, because both defaults route
the decision somewhere else — and both were caught doing it:

- Claude inherits the human's `permissions.defaultMode`; where that is `auto` the adapter approves
  its own calls and the bridge sees nothing. Fixed by selecting `default`.
- Codex's `agent` mode carries `approvalsReviewer: "auto_review"`, an automatic reviewer that
  answers instead of the client. Under it Codex overwrote a file two directories above its own
  root without asking. Fixed by selecting `read-only` — a name about approvals, not about writing:
  inside the workspace it still edits freely.

### What this does not protect against

Worth stating plainly, because the classifier looks stronger than it is:

- **The bridge only sees what the adapter chooses to ask about.** It is a supervisor over the
  decisions that reach it, not a sandbox.
- **Codex keeps /tmp and $TMPDIR writable without asking.** The policy is hardcoded per mode in
  the adapter and resent every turn, so neither `CODEX_CONFIG` nor anything else on the client
  side narrows it. Sandboxes are therefore created under `.acp-sandboxes/` in this repository and
  not in the temp tree — otherwise conversations could write into each other unobserved.
- **Symlinks planted inside the root after the check are not followed.** Paths are resolved once,
  which is enough for `/var` vs `/private/var` but not for an adversary.

## The MCP bridge

`src/mcp/` publishes the A2A agent to a calling agent (Claude Code) as four tools — `a2a_ask`,
`a2a_task`, `a2a_cancel`, `a2a_card` — over Streamable HTTP. It is an A2A **client**: it never
imports `src/acp/`, and reaches the agent over the network, so `A2A_URL` can point anywhere.

`yarn mcp` mints a bearer token, writes it to `.mcp-token` (mode 600, gitignored), prints it, and
prints the command that connects a client. `MCP_TOKEN` pins it across restarts.

Three decisions worth knowing before changing anything there:

- **Calls block until the task is terminal.** A client backgrounds a tool call that runs past two
  minutes and notifies on completion, so a handle-and-poll protocol would duplicate that — and the
  recovery path already exists as `a2a_task` with the real task id, because the task lives on the
  agent, not in this bridge.
- **The heartbeat is derived from liveness, not from a timer.** Progress notifications keep the
  client's five-minute idle window open, but ticking unconditionally would hide a wedged agent
  until the wall-clock limit (~28h). After `MCP_UPSTREAM_SILENCE_MS` without an upstream event the
  turn is aborted with an error. The gate must abort the stream, not merely record its verdict.
- **No `skills[]` projection.** The card declares one generic skill, so projecting it would yield
  one generic tool. Client-directed skill selection is being specified for A2A v1.1.

Full write-up: [docs/mcp-bridge.md](docs/mcp-bridge.md).

## Running as a service

`bin/ambassyctl` installs the same processes as background services — LaunchAgents on macOS,
`systemd --user` units on Linux — and drives both with one command:

```bash
yarn service install --with-mcp          # a2a + mcp; without the flag, the agent alone
yarn service install --backend codex     # claude (default), codex, or revisor for the stub
yarn service status | start | stop | restart | logs | token | uninstall
```

Two units (`a2a`, `mcp`) rather than one, for the reason the MCP section gives: the bridge is an
A2A *client*, so it has to be installable alone against a remote `A2A_URL`, and a crash in either
must not take the other down. Ordering between them is never enforced — the bridge builds its A2A
client lazily, so coming up first costs nothing.

A unit file carries only what selects the process: the entry point, absolute paths to `node` and
`tsx` (a service manager supplies no PATH, and under nvm the interpreter is nowhere a default one
would look — and the path comes from `process.execPath`, because under `yarn service …` Yarn's
own temporary `node` wrapper is what `command -v` finds, and it is deleted when the command
ends), and where stdout goes. Everything else stays in `.env` and takes effect on
`restart` — which works because the unit's own variables win, per the `loadEnvFile` rule above.

Three consequences worth knowing before changing anything there:

- **`MCP_TOKEN` is pinned at install.** Minted per start, it changes on every restart and
  invalidates the client config holding the old one — a nuisance by hand, an outage for a service.
- **`A2A_URL` is pinned too** when both units go in together, because its default names port
  41241 and a repository that moved `PORT` would leave the bridge pointing at nothing.
- **`src/agent.ts` reads no `.env`,** so `--backend revisor` copies `PORT`, `HOST`, `PUBLIC_URL`
  and `AGENT_NAME` into the unit — blank ones omitted, since the unit wins and an empty value
  would pin the default. The two bridges read the file themselves.

`status` prints what the service manager believes next to what the network answers: `card ok` is
the Agent Card responding, `guard ok` is the MCP endpoint refusing an unauthenticated probe with
401 — which proves the listener and the bearer guard in one call. Service stdout lands in
`logs/service/*.log`, which do not rotate; the structured logs still do.

Full write-up: [docs/service.md](docs/service.md).

## Protocol invariants

Violating any of these breaks the code silently or with a misleading error. All were verified
against live traffic:

- **An executor's first event must be `task` or `message`.** A stream that opens with
  `statusUpdate` or `artifactUpdate` is rejected by the server — including when continuing a task
  that already exists.
- **`Part` has two representations.** In TypeScript it is a discriminated union,
  `{ content: { $case: 'text', value } }`; on the wire it is flat,
  `{"text": "...", "mediaType": "..."}`. The schema is generated from a protobuf `oneof`, so parsing
  JSON by hand yields no union.
- **The `A2A-Version: 1.0` header is mandatory for raw HTTP calls.** Without it the server treats
  the caller as v0.3 and answers `-32009 VERSION_NOT_SUPPORTED`.
- **Wire method names are PascalCase**: `SendMessage`, `SendStreamingMessage`, `GetTask`,
  `CancelTask`, `ListTasks`. The v0.3 slash names (`message/send`, `tasks/get`) appear in the SDK
  only inside `compat/v0_3` — do not copy them from 0.2.x/0.3.x guides.
- **`INPUT_REQUIRED` is non-terminal.** The task stays alive; the client sends another message with
  the same `taskId`, and `execute` runs again, this time with `requestContext.task` populated.
- **Every SSE frame is a complete JSON-RPC response** carrying the request's `id`, not a bare payload.
- **`TaskState` is a numeric enum**, which is why the reverse lookup `TaskState[state]` works in logs.
- Errors arrive in the `google.rpc.ErrorInfo` shape (`data[].@type`, `reason`, `domain`).

On the ACP side, verified the same way:

- **`ndJsonStream(writable, readable)` takes the outgoing stream first.** The wrong order produces
  a connection that hangs rather than an error.
- **`mcpServers` must be present in `session/new`,** empty array included; a missing key is a hard
  error, while a malformed value is quietly replaced with `[]`.
- **Both adapters exit on stdin EOF** — by design, not by accident — so stdin stays open for the
  life of the process. `echo '…' | codex-acp` prints nothing and exits 0.
- **Claude validates `cwd`** on `session/new`: absolute, exists, is a directory, three distinct
  errors. Codex does not.
- **`CancelTask` insists on `CANCELED` in the store,** not merely on the executor having been
  told; see the cancellation section above.
- **Codex only ever returns `end_turn` or `cancelled`.** `refusal`, `max_tokens` and
  `max_turn_requests` exist in its schema but are never produced, and a terminal failure comes
  back as `end_turn` — which is why failed tool calls are counted separately.
- `ClientSideConnection` is deprecated in SDK 1.4.0; the current API is
  `acp.client({name}).onRequest(...).connect(stream)`.

## Longer prose

`docs/` carries the human-facing documentation: architecture, both protocols, the permission
model, configuration, logging and troubleshooting. This file stays terse on purpose — it is the
working guide, not the explanation.

## Source of truth

The specification outranks both the SDK and this file: <https://a2a-protocol.org/v1.0.0/specification/>.
The SDK implements v1.0.0; when behavior disagrees, check the spec rather than guessing from the
bundle — `dist` also ships the v0.3 compatibility layer, and its constants are easy to mistake for
the current ones.
