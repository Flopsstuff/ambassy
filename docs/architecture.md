# Architecture

## The whole picture

```
A2A client                 A2A server (:41241)                 ACP adapter (subprocess)
──────────                 ───────────────────                 ───────────────────────
GET  .well-known/…  ──►    agentCardHandler
POST /             ──►     jsonRpcHandler
                             └─ DefaultRequestHandler
                                  ├─ InMemoryTaskStore
                                  └─ AgentExecutor
                                       RevisorExecutor   (src/agent.ts — no model)
                                       AcpExecutor       (src/acp/agent.ts)
                                         │
                                         │  stdin/stdout, newline-delimited JSON-RPC
                                         ▼
                                       claude-agent-acp  or  codex-acp
                                         │
                                         ▼
                                       Claude Agent SDK / codex app-server
```

Both servers listen on the same port and the same interface — `127.0.0.1` unless `HOST` says
otherwise — and serve the same protocol, so `yarn client`, `yarn raw` and `yarn tap` work against
either without a change. That is the point of the exercise: the
client cannot tell from the wire whether the work is done by twenty lines of `String.split` or by
a coding agent, and it should not have to.

## Three layers that must not be conflated

The A2A server side is three distinct things stacked, and mixing them up is the most common way
to get lost in the SDK:

1. **`AgentExecutor`** — the business logic. It returns nothing. It publishes events to an
   `ExecutionEventBus` through `AgentEvent.task()`, `.statusUpdate()` and `.artifactUpdate()`.
2. **`DefaultRequestHandler`** — routing, the task store, cancellation, push notifications. It
   owns the lifecycle; the executor only describes what happens inside one.
3. **The transport adapter** — `jsonRpcHandler` from `@a2a-js/sdk/server/express`. The Agent Card
   is served separately by `agentCardHandler`. One request handler can be mounted on several
   transports at once.

## The bridge's process model

One adapter subprocess per A2A `contextId`. A conversation therefore gets:

- its own process, so conversations cannot see each other's memory;
- its own ACP session, so a task continued after `INPUT_REQUIRED` lands where the first turn is
  remembered;
- its own working directory, unless `ACP_CWD` was set (see [configuration](configuration.md));
- one turn at a time — `Runtime.run` serialises prompts, because two prompts in one session would
  interleave in the same update queue.

Lifetimes:

| Thing | Created | Destroyed |
|---|---|---|
| Startup handshake adapter | Server start | Immediately, once `initialize` answers |
| Runtime (process + session) | First task of a conversation | Idle past `ACP_IDLE_TIMEOUT_MS`, or server shutdown |
| Sandbox directory | With the runtime | Never — left behind so you can see what the agent did |
| A2A task | `SendMessage` | Terminal state; the store is in memory and dies with the server |

A task that is still open — including one parked in `INPUT_REQUIRED` — keeps its adapter alive.
The alternative is worse: a follow-up turn would silently arrive in a fresh session with no memory
of the question it is answering. The cost is that a conversation abandoned after the first message
holds one idle process until the server stops.

## Why the card is built at startup

`src/acp/agent.ts` starts an adapter once before listening, sends `initialize`, reads the agent's
own `agentInfo`, and shuts it down. The Agent Card is then built from that answer rather than from
a guess, and a backend that cannot start takes the server down at boot instead of on the first
request. It costs one process start.
