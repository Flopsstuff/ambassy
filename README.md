# Ambassy

**One agent delegates a task to another that lives somewhere else** — on its own machine, under its
own credentials, inside limits that neither of them can widen. That exchange is what this
repository is about; everything else in it exists to make the exchange possible and to keep it
honest.

The obstacle is the shape a coding agent comes in. Claude Code and Codex run as a child process of
whatever launched them, talking over a pipe — right for an editor sitting next to one, wrong for
anybody further away. Ambassy gives that process a network address, a task that outlives the call,
and a supervisor that is neither of the two parties.

It is a sandbox for the **A2A Protocol v1.0** first and a working bridge second: everything here was
checked against live traffic rather than inferred from the specification, and where the two
disagreed, what actually happened is what is written down.

**Version 0.1 — an MVP that works.** Tasks live in memory and vanish with the process, the A2A side
has no authentication, and the permission classifier is a placeholder for a real external channel.
It runs, it is used, and none of those three are things to put in front of a network you do not
own.

![One agent hands a task through Ambassy to a coding agent running on its own machine: MCP, A2A and ACP stacked in the bridge, with the permission decision made inside it](docs/assets/ambassy-overview.jpg)

## The problem it solves

**ACP** (Agent Client Protocol) is built for that editor case, and what it leaves out is exactly
what delegation needs:

- **No address.** Nothing outside the process that spawned it can reach the agent — not another
  program, not another machine.
- **No task.** A call is either in flight or lost. You cannot walk away and collect the answer
  later, cancel a turn that went wrong, or answer a question the agent asked an hour ago.
- **No boundary.** Whoever launches the agent approves its actions. When the launcher is itself an
  agent doing what it was told, that approval checks nothing.

**A2A** answers the first two. An agent publishes a card at a well-known URL, a task is an
addressable thing with a lifecycle (`SUBMITTED → WORKING → INPUT_REQUIRED → COMPLETED`), and the
task lives on the agent, so a client that drops off can come back by id.

The third is a design decision, not a protocol feature, and Ambassy's answer is: **the bridge
decides, and the caller is never asked.** The A2A client is the party that wants the work done —
making it the supervisor would be a loop, not a check.

**MCP** closes the circle from the other side: it publishes the A2A agent to a calling agent as
four tools, so asking a remote coding agent for something is a tool call rather than a curl script.

```
your Claude Code             Ambassy                             the machine doing the work
────────────────             ───────                             ──────────────────────────
a2a_ask(…)      ──MCP──►   src/mcp/       ──A2A──►   src/acp/agent.ts   ──ACP──►  claude-agent-acp
  a2a_task                 an A2A client  HTTP/SSE   an A2A server      stdio     └─ Claude Code
  a2a_cancel                                              │                          or codex-acp
  a2a_card                                          permissions.ts
                                                    (decides here, never upstream)
```

Three protocols, and the first two are easy to confuse because both are JSON-RPC:

| | Direction | The agent is | Carries |
|---|---|---|---|
| **A2A** | between peers, over HTTP | the server | a task with an identity and a lifecycle |
| **ACP** | editor → coding agent, over a pipe | a subprocess | one turn, streamed as it happens |
| **MCP** | calling agent → tools | a tool endpoint | a call that blocks until the task is terminal |

What that adds up to in practice: the coding agent stays on the machine that holds its credentials
and its files, while the work is handed to it over the network — and neither the caller nor the
agent can widen what it is allowed to do.

## Running it

Start with the stub. It has no model behind it, so the protocol is all that is left:

```bash
yarn agent     # A2A server on :41241, placeholder executor
yarn client    # SDK client: discovery, streaming, resuming a task
yarn raw       # the same exchange in bare curl, no SDK
```

Then put a real coding agent behind the same interface:

```bash
yarn agent:claude   # A2A on :41241, claude-agent-acp behind it
yarn agent:codex    # the same, with codex-acp
```

Same port, same card, same SSE stream — `yarn client`, `yarn raw` and `yarn tap` work against
either without a change, which is the point: a client cannot tell from the wire whether the answer
came from twenty lines of `String.split` or from a coding agent, and it should not have to.

To publish the agent to your own Claude Code, and to watch the raw protocol:

```bash
yarn mcp                                        # MCP endpoint on :41243, prints the token and the connect command
PUBLIC_URL=http://localhost:41242/ yarn agent   # agent advertises the tap's address in its card
yarn tap                                        # proxy :41242 → :41241, prints every frame
AGENT_URL=http://localhost:41242 yarn client
```

Both servers bind `127.0.0.1` by default: an A2A agent here runs with no authentication, so a wider
bind hands a coding agent to the network. The MCP endpoint is the side meant to face one, and it
has a bearer token.

To keep it running — on this machine or the one that does the work:

```bash
yarn service install --with-mcp    # LaunchAgents on macOS, systemd --user units on Linux
yarn service status                # what the service manager believes, next to what the network answers
yarn service token                 # the endpoint, the token, and a ready .mcp.json block
```

Copy `.env.example` to `.env` for the rest: where the agent may work, what it is called
(`AGENT_NAME` names it in both the Agent Card and the MCP `serverInfo`), and how long an idle
conversation lives. By default each conversation gets its own directory under `.acp-sandboxes/`.

## Documentation

**<https://flopsstuff.github.io/ambassy/>** — or [`docs/`](docs/) in this repository.

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

**Cancelling means ending up `CANCELED`, not merely being told.** `CancelTask` drains the event bus
and then insists the stored state is `CANCELED`; a task that finishes normally after the cancel
comes back to the caller as `-32002 TASK_NOT_CANCELABLE`. An executor that forwards the cancel and
lets the turn finish looks broken from outside.

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

Specifications, one per protocol this repository speaks:

- A2A v1.0.0 — <https://a2a-protocol.org/v1.0.0/specification/>
- ACP — <https://agentclientprotocol.com/protocol/overview>
- MCP `2025-06-18` — <https://modelcontextprotocol.io/specification/2025-06-18>

## Changes

What changed and why, release by release: [CHANGELOG.md](CHANGELOG.md).

## License

Apache License 2.0 — see [LICENSE](LICENSE).
