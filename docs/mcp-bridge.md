# The MCP bridge

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

## The four tools

| Tool | Arguments | What it does |
|---|---|---|
| `a2a_ask` | `text`, `contextId?`, `agent?` | Sends a request and blocks until the task is terminal, streaming progress |
| `a2a_task` | `taskId`, `agent?` | Reads a task back, with its state and artifacts |
| `a2a_cancel` | `taskId`, `agent?` | Asks the agent to stop |
| `a2a_card` | `agent?` | The agent card as published |

`agent` may be omitted while only one agent is configured.

`contextId` is the conversation and `taskId` is one unit of work inside it. This matters more than
it looks: the ACP bridge keeps one adapter process and one session per `contextId`, so passing the
same `contextId` back is what makes the agent remember the previous turn. A fresh `contextId`
starts a fresh session with a fresh sandbox.

### Generic tools, not one per skill

Projecting the card's `skills[]` into a tool each sounds better than a single free-text entry
point, and for some agents it would be. Not for this one: it advertises exactly one generic skill,
so the projection would yield one tool taking one string — the same thing, with extra machinery.

The general version of that idea is being specified as *client-directed skill selection* for A2A
v1.1. A private dialect of it now would have to be unpicked later.

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
