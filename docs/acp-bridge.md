# The ACP bridge

`src/acp/agent.ts` is the A2A server from `src/agent.ts` with the placeholder executor replaced by
one that forwards the task to a real coding agent. The backend is chosen by the launch command:

```bash
yarn agent:claude   # claude-agent-acp, the Claude Agent SDK
yarn agent:codex    # codex-acp, which itself drives a codex app-server child
```

## ACP in one paragraph

ACP is the mirror image of A2A. The agent is a child process addressed over stdin/stdout in
newline-delimited JSON-RPC, and the *client* is whoever launched it — normally an editor, here the
bridge. The client declares capabilities, opens a session with a working directory, sends a
prompt, and then reads a stream of updates until the turn stops. Along the way the agent asks the
client for permission and, if the client advertised it, for file access.

```
initialize  ──►  session/new  ──►  session/prompt  ──►  session/update × N  ──►  stop
                                        ▲                      │
                                        └── session/request_permission ──┘
```

## Connecting

```ts
const child = spawn(bin, [], { cwd: root, stdio: ['pipe', 'pipe', 'inherit'] });
const stream = acp.ndJsonStream(
  Writable.toWeb(child.stdin),    // writable first — outgoing
  Readable.toWeb(child.stdout),   // readable second
);
const conn = acp.client({ name: 'ambassy-bridge' })
  .onRequest(acp.methods.client.session.requestPermission, …)
  .onRequest(acp.methods.client.fs.readTextFile, …)
  .onRequest(acp.methods.client.fs.writeTextFile, …)
  .connect(stream);
```

`connect`, not `connectWith`: the connection must outlive a single callback. `ClientSideConnection`
still exists but is deprecated in SDK 1.4.0.

The bridge advertises `fs.readTextFile` and `fs.writeTextFile` deliberately. Declaring them makes
the agent route file access through the bridge rather than touching the disk unobserved, so every
read and write passes the boundary check and lands in the log. `terminal` is not advertised —
the adapters then run commands themselves, and the bridge only sees the permission request.

## Supervised session mode

After `session/new` the bridge sets the session mode explicitly instead of accepting the default,
because both defaults route the decision somewhere other than the bridge. Both were caught doing
it:

- **Claude** inherits the human's own `permissions.defaultMode` from Claude Code settings. Where
  that is `auto`, the adapter approves its own tool calls and not one request arrives. The bridge
  selects `default` ("Manual").
- **Codex**'s `agent` mode carries `approvalsReviewer: "auto_review"` — an automatic reviewer that
  answers on the client's behalf. Under it Codex overwrote a file two directories above its own
  root without asking. The bridge selects `read-only`, whose reviewer is `user`. The name is about
  approvals, not about writing: inside the workspace it still edits freely.

The two vocabularies do not overlap, so the mode is a per-backend constant in `BACKENDS`.

## Event mapping

| ACP | A2A |
|---|---|
| — | `AgentEvent.task()` first, always |
| empty request | `INPUT_REQUIRED`, and the adapter stays up |
| `agent_message_chunk` | `WORKING` + text, coalesced; collected for the artifact |
| `agent_thought_chunk` | `WORKING`, marked as thinking |
| `tool_call` | `WORKING`: `«title» (kind, status)` |
| `tool_call_update` | `WORKING`, only when the status actually changed |
| `plan` | `WORKING`, the entries as a list |
| `stop: end_turn` | `artifactUpdate` (`acp-answer`) + `COMPLETED` |
| `stop: cancelled` | `CANCELED`, carrying the refusal reason when the classifier caused it |
| `stop: refusal` | `FAILED` |
| `stop: max_tokens`, `max_turn_requests` | `COMPLETED`, the reason in the artifact's data part |
| anything else | ignored, but the `default:` branch must exist — agents may invent tags |

The artifact carries two parts: the assembled answer as text, and a data part with `backend`,
`sessionId`, `root`, `stopReason`, every tool call, the count of failed ones, refusals, and token
usage.

**Chunks are coalesced on purpose.** Codex streams one token per update; forwarded verbatim that
buries the wire under hundreds of single-word SSE frames, while Claude arrives in paragraphs and
reads fine. Text is buffered and flushed at 160 characters, on a newline, before any tool or plan
frame, and at the end of the turn.

## Cancellation

In ACP cancelling is a notification, not a request: `session/cancel` goes out, updates keep
arriving, and the turn closes with `stopReason: 'cancelled'`.

Two cases need care, because of the [A2A contract](a2a.md#the-canceltask-contract):

- **A cancel can arrive before there is a session to cancel.** The first event must be `task`, and
  it is published before the adapter is acquired, so a client reacting to that first frame gets in
  while `spawn`, `initialize` and `session/new` are still running — several seconds. `cancelTask`
  therefore records the task id as well as sending the notification, and `execute` checks that
  flag after acquiring the runtime and stops before prompting.
- **A turn may end `end_turn` despite the cancel.** The artifact is published anyway, so the work
  that happened is not discarded, and the task then reports `CANCELED`.

## Differences the bridge has to absorb

| | claude-agent-acp | codex-acp |
|---|---|---|
| `stopReason` | all five values | only `end_turn` and `cancelled`; a terminal failure arrives as `end_turn` |
| Authentication failure | at `session/prompt` | at `session/new`, as `-32000` |
| A wrong `optionId` | throws, the turn fails | silently becomes a cancel |
| `current_mode_update` | sent | never sent |
| Mode vocabulary | `default`, `acceptEdits`, `plan`, `auto` | `read-only`, `agent`, `agent-full-access` |
| `models` in the `session/new` reply | absent | present |
| stderr | everything goes there | nearly silent; the child's stderr is swallowed unless `APP_SERVER_LOGS` is set |

Because Codex never reports `refusal` or the token ceilings, and hides terminal failures behind
`end_turn`, the bridge counts failed tool calls separately rather than trusting `stopReason` alone.

## ACP invariants

- **`ndJsonStream(writable, readable)` takes the outgoing stream first.** The wrong order gives a
  connection that hangs rather than an error.
- **`mcpServers` must be present in `session/new`**, empty array included. A missing key is a hard
  error; a malformed value is quietly replaced with `[]`.
- **Both adapters exit on stdin EOF**, by design. `echo '…' | codex-acp` prints nothing and exits
  0. stdin stays open for the life of the process.
- **Claude validates `cwd`** on `session/new`: absolute, exists, is a directory — three distinct
  errors. Codex does not.
