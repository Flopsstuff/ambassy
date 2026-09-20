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
```

All three servers listen on the same port and serve the same protocol, so `client`, `raw` and
`tap` work against any of them without a change.

To inspect raw traffic (three terminals):

```bash
PUBLIC_URL=http://localhost:41242/ yarn agent   # agent advertises the tap's address in its card
yarn tap
AGENT_URL=http://localhost:41242 yarn client
```

`PUBLIC_URL` exists solely for that scenario: the client takes its address from
`supportedInterfaces[].url` in the Agent Card, so without the substitution it connects directly
and bypasses the proxy.

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
- **Codex only ever returns `end_turn` or `cancelled`.** `refusal`, `max_tokens` and
  `max_turn_requests` exist in its schema but are never produced, and a terminal failure comes
  back as `end_turn` — which is why failed tool calls are counted separately.
- `ClientSideConnection` is deprecated in SDK 1.4.0; the current API is
  `acp.client({name}).onRequest(...).connect(stream)`.

## Source of truth

The specification outranks both the SDK and this file: <https://a2a-protocol.org/v1.0.0/specification/>.
The SDK implements v1.0.0; when behavior disagrees, check the spec rather than guessing from the
bundle — `dist` also ships the v0.3 compatibility layer, and its constants are easy to mistake for
the current ones.
