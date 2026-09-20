# rob-a2a — an A2A Protocol v1.0 sandbox

A minimal agent, a client and a wire-tap, so you can poke the protocol by hand.
Everything here was verified against live traffic using `@a2a-js/sdk` 1.2.0 (spec v1.0.0).

## Running it

```bash
yarn agent     # agent on :41241
yarn client    # client: two-turn conversation with streaming
yarn raw       # the same protocol with bare curl, no SDK
```

Or put a real coding agent behind the same A2A interface:

```bash
yarn agent:claude   # A2A on :41241, claude-agent-acp behind it
yarn agent:codex    # the same, with codex-acp
```

Same port, same card, same SSE stream — so `yarn client`, `yarn raw` and `yarn tap` work against
the bridge unchanged. Copy `.env.example` to `.env` to choose where the agent is allowed to work;
by default each conversation gets its own directory under `.acp-sandboxes/`.

To watch the raw protocol:

```bash
PUBLIC_URL=http://localhost:41242/ yarn agent   # agent advertises the tap's address in its card
yarn tap                                        # proxy :41242 → :41241, prints everything
AGENT_URL=http://localhost:41242 yarn client
```

## Files

| File | What it demonstrates |
|---|---|
| `agent.ts` | A2A server: Agent Card, `AgentExecutor`, streaming status updates, `INPUT_REQUIRED`, artifacts |
| `client.ts` | Card-based discovery, `sendMessageStream`, resuming a task, `getTask` |
| `proxy.ts` | Wire-tap: raw JSON-RPC requests and SSE frames |
| `raw.sh` | The same protocol over curl: discovery → version negotiation → send → stream → get |
| `acp-agent.ts` | The same A2A server with a real coding agent behind it: ACP updates translated into A2A events |
| `acp-client.ts` | The ACP side: one adapter subprocess per conversation, sessions, idle reaping |
| `acp-permissions.ts` | Who may do what, and the `fs/*` handlers that keep the agent inside its root |

## What practice revealed

**Wire method names are PascalCase**: `SendMessage`, `SendStreamingMessage`, `GetTask`,
`CancelTask`, `ListTasks`. Not to be confused with v0.3, which used `message/send` and `tasks/get` —
those names survive in the SDK only inside `compat/v0_3`.

**The `A2A-Version: 1.0` header is mandatory.** Without it the server treats you as a v0.3 client
and answers with `-32009 VERSION_NOT_SUPPORTED`. This is the single most common reason a
hand-written curl call fails.

**`Part` looks different in TypeScript and on the wire.** In code it is a discriminated union,
`{ content: { $case: 'text', value } }`; in JSON it is flat: `{"text": "...", "mediaType": "text/plain"}`.
That follows from the schema being generated out of a protobuf `oneof`.

**An executor's first event must be `task` or `message`.** Start with a `statusUpdate` and the
server rejects the stream. This holds for continuations of an existing task too.

**An SSE frame is a complete JSON-RPC response**, carrying the same `id` as the request — not a
bare payload.

**`INPUT_REQUIRED` is a non-terminal state.** The task stays alive, the client sends another
message with the same `taskId`, and work resumes. This is precisely what separates A2A from an
ordinary `POST /do`: the call has state, history and an identity.

**An agent that approves its own permissions is not being checked.** The bridge never asks the
calling A2A client whether the coding agent may edit a file — the caller is the party that wants
the work done, not a supervisor. The decision is made inside the bridge, and the classifier there
is a placeholder for a real external channel. See AGENTS.md for what it does and does not stop.

**Errors use the google.rpc shape**: `data[].@type = type.googleapis.com/google.rpc.ErrorInfo`,
with `reason` and `domain` fields.

## Where to go next

The official samples worth reading first — the SDK's own README points at them:
`multi-transport-agent` (one agent served over JSON-RPC, REST and gRPC at once),
`push-notification-agent` (webhooks instead of SSE for long-running tasks),
`authentication` (Bearer/JWT via Passport), `verify-signing` (signed cards, JWS + JWKS),
and `extensions` (protocol extensions).

Specification: https://a2a-protocol.org/v1.0.0/specification/
