# The A2A side

Specification: <https://a2a-protocol.org/v1.0.0/specification/>. The SDK is `@a2a-js/sdk` 1.2.0,
which implements v1.0.0. When the two disagree, trust the spec — `dist` also ships a v0.3
compatibility layer whose constants are easy to mistake for current ones.

## Discovery

Everything starts from the Agent Card at `.well-known/agent-card.json`: a declaration of skills,
input and output modes, security schemes, and the transports the agent answers on.

```jsonc
{
  "name": "Revisor",
  "supportedInterfaces": [
    { "url": "http://127.0.0.1:41241/", "protocolBinding": "JSONRPC", "protocolVersion": "1.0" }
  ],
  "capabilities": { "streaming": true, "pushNotifications": false },
  "skills": [ { "id": "text_stats", "inputModes": ["text"], "outputModes": ["text", "data"] } ]
}
```

`name` is the only field in there that identifies *this* agent rather than what it can do, so it
is what a caller has to go on with two of them in front of it. It comes from `AGENT_NAME`; blank
leaves the built-in name — `Revisor` above, `Claude (via ACP)` or `Codex (via ACP)` on the bridge.

The client hardcodes neither a URL nor a protocol: `ClientFactory.createFromUrl()` fetches the
card and picks a transport out of `supportedInterfaces`. It dials what the card says, not the
address it fetched the card from, and `PUBLIC_URL` is the knob over that field: it routes a client
through the wire-tap instead of letting it connect directly, and it is what has to move when
`HOST` does, or the card advertises an address the caller cannot reach.

## The task lifecycle

```
SUBMITTED ──► WORKING ──► COMPLETED
     │           │
     │           ├──► FAILED
     │           └──► CANCELED
     └──► INPUT_REQUIRED ──► (client replies into the same taskId) ──► WORKING ──► …
```

`INPUT_REQUIRED` is the state that separates A2A from an ordinary `POST /do`. It is **not
terminal**: the task stays alive, the client sends another message carrying the same `taskId`, and
`execute` runs again — this time with `requestContext.task` populated. The call has state, history
and an identity.

## Streaming

`SendStreamingMessage` answers with Server-Sent Events. Each frame is a **complete JSON-RPC
response** carrying the request's `id`, not a bare payload:

```
data: {"jsonrpc":"2.0","id":3,"result":{"statusUpdate":{"taskId":"…","status":{"state":"TASK_STATE_WORKING", …}}}}
```

The result of the work arrives as an **artifact**, not as a message: a named object with parts,
which the client can store and refer to later. `GetTask` returns it long after the stream closed.

## Invariants that bite

All of these were verified against live traffic. Each one breaks the code either silently or with
a misleading error.

**The first event must be `task` or `message`.** A stream that opens with `statusUpdate` or
`artifactUpdate` is rejected — including when continuing a task that already exists. The bridge
publishes the task snapshot before anything else for exactly this reason.

**Wire method names are PascalCase**: `SendMessage`, `SendStreamingMessage`, `GetTask`,
`CancelTask`, `ListTasks`. The v0.3 slash names (`message/send`, `tasks/get`) survive in the SDK
only inside `compat/v0_3`; do not copy them from 0.2.x/0.3.x guides.

**The `A2A-Version: 1.0` header is mandatory for raw HTTP calls.** Without it the server treats
the caller as v0.3 and answers `-32009 VERSION_NOT_SUPPORTED`. This is the single most common
reason a hand-written curl call fails, and `src/raw.sh` demonstrates it on purpose.

**`Part` has two representations.** In TypeScript it is a discriminated union,
`{ content: { $case: 'text', value } }`; on the wire it is flat,
`{"text": "…", "mediaType": "text/plain"}`. The schema is generated from a protobuf `oneof`, so
parsing the JSON by hand yields no union.

**`TaskState` is a numeric enum**, which is why the reverse lookup `TaskState[state]` works in
logs. Errors arrive in the `google.rpc.ErrorInfo` shape: `data[].@type`, `reason`, `domain`.

## The CancelTask contract

Stricter than it looks. `DefaultRequestHandler.cancelTask`:

1. loads the task and rejects outright if it is already terminal;
2. calls `executor.cancelTask`;
3. **drains the event bus until the task reaches a terminal state**;
4. requires the stored state to be `CANCELED`.

Anything else — a perfectly ordinary `COMPLETED` included — reaches the caller as
`-32002 TASK_NOT_CANCELABLE`. An executor that merely forwards the cancellation and lets the turn
finish therefore looks broken from outside. How the bridge satisfies this is in
[acp-bridge.md](acp-bridge.md#cancellation).
