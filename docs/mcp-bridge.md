# The MCP bridge

Specification: <https://modelcontextprotocol.io/specification/2025-06-18> — the version this
bridge answers `initialize` with. The SDK is `@modelcontextprotocol/server` 2.0.0, over
Streamable HTTP.

A third protocol joins the two others, and it points the other way. A2A and ACP are both about
reaching *down* to an agent that does work. MCP is how a calling agent — Claude Code, here —
reaches *out* to tools. This bridge publishes the A2A agent as four such tools, so calling it
stops being a curl exercise.

```
Claude Code ──MCP (Streamable HTTP + Bearer)──▶ src/mcp/  ──A2A──▶ :41241 ──ACP──▶ coding agent
```

`src/mcp/` is an A2A **client** and nothing more. It never imports `src/acp/`; it talks to the
agent over the network like any other peer, so pointing `A2A_URL` at someone else's agent needs no
code change.

Run it with `yarn mcp`. It prints its bearer token and the exact command that connects a client
to it.

It introduces itself as `ambassy-mcp` in the `serverInfo` of every `initialize` response, which
is the only name the calling agent ever sees for this endpoint — and the only way to tell two of
them apart in one client config. `AGENT_NAME` replaces it, and is the same key that names the
agent in its Agent Card: from the caller's side both are the name of the thing it is reaching.
The bearer realm does not follow it, because a realm names the credential that opens the
endpoint and renaming the agent mints no new token.

## The four tools

| Tool | Arguments | What it does |
|---|---|---|
| `a2a_ask` | `text`, `contextId?`, `taskId?`, `agent?` | Sends a request and blocks until the task is terminal, streaming progress |
| `a2a_task` | `taskId`, `agent?` | Reads a task back, with its state, its artifacts and the agent's last word |
| `a2a_cancel` | `taskId`, `agent?` | Asks the agent to stop |
| `a2a_card` | `agent?` | The agent card as published |

`agent` may be omitted while only one agent is configured.

`contextId` is the conversation and `taskId` is one unit of work inside it. This matters more than
it looks: the ACP bridge keeps one adapter process and one session per `contextId`, so passing the
same `contextId` back is what makes the agent remember the previous turn. A fresh `contextId`
starts a fresh session with a fresh sandbox.

Both are arguments of `a2a_ask`, and the pair is not decoration:

- **`taskId` continues that task.** `INPUT_REQUIRED` is non-terminal — the task stays open with its
  history, and A2A continues it by sending the next message *with the same task id*. Answering with
  the context alone opens a **second** task instead, which leaves the first one parked forever; with
  the ACP bridge behind it, parked also means an adapter process kept alive for a question nobody is
  going to answer. The result of an interrupted turn therefore names the task id to reply into.
- **Omitting `taskId` starts new work in the same conversation.** That is a different, equally real
  intention: a fresh task, the agent's session and memory intact.

### Generic tools, not one per skill

Projecting the card's `skills[]` into a tool each sounds better than a single free-text entry
point, and for some agents it would be. Not for this one: it advertises exactly one generic skill,
so the projection would yield one tool taking one string — the same thing, with extra machinery.

The general version of that idea is being specified as *client-directed skill selection* for A2A
v1.1. A private dialect of it now would have to be unpicked later.

## How a turn can end

A stream is not a single answer, and "what state is the task in" is a different question from "did
this turn reach an ending at all". `a2a_ask` reports both: the A2A state, and one of four outcomes.

| Outcome | What happened | `isError` |
|---|---|---|
| `task` | The task reached a terminal state — `COMPLETED`, `FAILED`, `CANCELED` or `REJECTED` | only for the last three |
| `message` | The agent answered with a Message and opened no task. A complete answer in A2A | no |
| `interrupted` | `INPUT_REQUIRED` or `AUTH_REQUIRED`: alive, and waiting on the caller | no — the result says what to do |
| `truncated` | The stream stopped before any of those. A turn that lost its ending | yes |

`truncated` is the one that has to exist. A stream that dies after a `WORKING` update leaves a
perfectly well-formed result saying the agent "finished in `TASK_STATE_WORKING`", and an empty
stream one saying it finished in `TASK_STATE_UNSPECIFIED`. Neither is a failure the caller can
see without being told, so both are errors here, and both carry the task id to recover from.

Failed and cancelled work keeps whatever it produced. Cancelling late does not unmake an artifact,
and the ACP bridge deliberately publishes its answer before reporting `CANCELED`.

### The agent's last word

The reason a task failed or was refused usually travels in its final **status message**, not in an
artifact — that is where the ACP bridge puts a permission refusal (`Refused by the bridge: …`) and
where an authentication error surfaces. So the latest status message is retained through the turn
and reported by both `a2a_ask` and `a2a_task`; without it a denial is invisible unless the caller
happened to be watching progress notifications.

### Artifacts are aggregated, not concatenated

Artifacts arrive in pieces keyed by `artifactId`, and `append` says whether a piece extends the
previous one or replaces it. Concatenating everything regardless merges artifacts that were never
the same artifact, and turns two replacements of one artifact — `old`, then `new` — into `oldnew`.
So updates are aggregated by id, `append: false` replaces, artifacts already present in the task
snapshot are kept (they are the earlier turns of the conversation), and every data part survives:
one artifact may carry several, and a later one is not a correction of the first.

## Why a call may simply block

An MCP tool call is a request and a response; an A2A task can run for an hour. The obvious fix is
to return a handle and let the caller poll — and it is the wrong one here, for two reasons.

The first is that the client already solves it. A tool call still running after two minutes is
moved to a background task; the caller is handed an id immediately and is notified when the call
settles. A handle-and-poll protocol on top of that is a second mechanism doing the first one's job.

The second is that a handle registry would be a task registry, and A2A already specifies one. The
recovery path is `a2a_task` with the real `taskId`, which works because the task lives on the agent
rather than in this bridge's memory. Nothing expires here.

## Keeping a long call alive

A client drops a tool call that goes quiet — five minutes for an HTTP MCP server — and any progress
notification resets that window. An agent that thinks for six minutes in silence would otherwise
lose a call that was going perfectly well.

So `a2a_ask` forwards every A2A event as a progress notification, and `src/mcp/heartbeat.ts` adds a
tick of its own whenever the upstream has been quiet for `MCP_HEARTBEAT_MS`.

The part worth reading twice is what stops it. A tick on a plain timer would keep a *wedged* agent
alive just as faithfully as a working one, and the idle window is the only thing that would
otherwise have noticed — removing it means a hung turn holds the call until the wall-clock limit,
which defaults to roughly 28 hours. The tick is therefore derived from liveness: after
`MCP_UPSTREAM_SILENCE_MS` without a single upstream event the turn is **aborted** and the tool
returns an error saying so. Detection moves from the client into the bridge, which is the only
place that can tell a slow agent from an absent one.

Two details that are easy to get wrong:

- `progress` must strictly increase within one request, so it counts notifications rather than
  reporting elapsed time or a percentage nobody can estimate.
- The gate has to abort the stream, not merely record its verdict. An earlier version noted the
  silence and then awaited the turn anyway, which held the call exactly as long as doing nothing
  would have.

Progress may only be sent when the caller supplied a `progressToken` in the request's `_meta`.
Whether a given client does is logged on every call as `mcp.ask { hasProgressToken }`, because the
whole scheme depends on it.

## Everything else gets a deadline too

The silence gate covers `a2a_ask` and nothing else, which left the other three tools able to wait
forever on a server that accepted the connection and then said nothing. Two limits close that:

- **`MCP_DISCOVERY_TIMEOUT_MS`** (20 s) bounds fetching the agent card and negotiating a transport.
- **`MCP_REQUEST_TIMEOUT_MS`** (30 s) bounds one request/response call — `a2a_task`, `a2a_cancel`,
  `a2a_card`.

Discovery is bounded *separately*, and that is the interesting part. The handshake is cached per
agent, so several tool calls wait on the same promise — which means the abort of one of them must
not be passed down into it. A caller's signal therefore ends only that caller's wait, while the
deadline belongs to the handshake and ends it for everyone. A tool call that is cancelled while the
card is in flight settles at once; the caller that is still waiting goes on to get its answer from
the same handshake. Verified both ways round.

## When a call does not survive

Interrupting an `a2a_ask` — a client that hangs up, a silence timeout, a broken stream — does **not**
stop the agent. Disconnecting from an A2A stream is not a cancellation; the task keeps running, and
stopping it takes an explicit `a2a_cancel`. Whether that is what you want is the caller's decision,
so the bridge makes the handle available rather than deciding for them:

- **The first progress notification carries the identity**, task id and context id in full, so a
  caller watching progress has a handle from the first frame rather than after the answer.
- **Errors carry it too.** A silence timeout, a broken stream and a truncated turn all report the
  agent, task and context, plus the two calls that reach the work: `a2a_task` and `a2a_cancel`.
- **A caller that hung up reads nothing we return**, so the identity goes to `calls.jsonl` instead,
  as `mcp.ask.abandoned { agent, taskId, contextId, reason }` (`a2a.ask.broken` records the stream
  side of the same event). For a request that brought no progress token and is no longer listening,
  that log line is the only correlation left.

## Authentication

The token is minted at startup with `crypto.randomBytes(32)`, written to `.mcp-token` at the
repository root with mode `600`, printed to stdout, and required as `Authorization: Bearer …` on
every request. `MCP_TOKEN` pins it instead, which is what you want once a client config holds it —
a generated token changes on every restart.

It is compared in constant time, over SHA-256 digests rather than the raw strings: `timingSafeEqual`
throws on buffers of different lengths, and that throw would itself leak the expected length.

The SDK ships `requireBearerAuth`, and this bridge does not use it. That helper is built for OAuth
access tokens — it runs a verifier, enforces scopes, and rejects a token that carries no expiry.
Ours is a bootstrap secret with no issuer and no expiry, and satisfying that contract would mean
minting a fake `expiresAt` and pretending to be an authorization server.

`MCP_HOST` defaults to `127.0.0.1`, and the SDK enables DNS-rebinding protection automatically for
a loopback bind. Binding wider turns that off, so `MCP_ALLOWED_HOSTS` has to name the hostnames
that are acceptable in the `Host` header — and at that point the bearer token is the only thing
between a stranger and an agent that can read files.

## Statelessness

A fresh MCP server and transport are built per HTTP request and disposed when it closes. There is
no session state worth keeping: the conversation is the A2A `contextId`, which the caller passes
back in, and the task lives on the agent.
