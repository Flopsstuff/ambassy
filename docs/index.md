---
layout: home

hero:
  name: Ambassy
  text: Three protocols, wired together
  tagline: A sandbox for the A2A protocol v1.0 with a working bridge on top of it — the same A2A interface, answered by a real coding agent over ACP instead of by a placeholder.
  actions:
    - theme: brand
      text: Architecture
      link: /architecture
    - theme: alt
      text: The A2A side
      link: /a2a
    - theme: alt
      text: Repository audit
      link: /repository-audit

features:
  - title: A2A points sideways
    details: One agent delegates a task to another over HTTP. The task is addressable, has a lifecycle, and survives the call that created it.
    link: /a2a
    linkText: Cards, states, streaming
  - title: ACP points down
    details: What an editor speaks to a coding agent over stdin/stdout. The roles are reversed there — the agent is a child process, and the bridge is the client.
    link: /acp-bridge
    linkText: Adapters and sessions
  - title: MCP points out
    details: How a calling agent reaches tools. It is what publishes this A2A agent to Claude Code as four things it can call.
    link: /mcp-bridge
    linkText: Tools over HTTP
---

## What this is

Three protocols meet here, and the first two are easy to confuse because both are JSON-RPC:
[A2A](https://a2a-protocol.org/v1.0.0/specification/) between agents,
[ACP](https://agentclientprotocol.com/protocol/overview) down to a coding agent, and
[MCP](https://modelcontextprotocol.io/specification/2025-06-18) back out to whoever is calling.
The bridge sits between them.

Everything in these pages was checked against running code, not inferred from specifications —
where behaviour and documentation disagreed, the observed behaviour is what is written down, and
the disagreement is called out.

It is not production: tasks live in an `InMemoryTaskStore`, the A2A side runs
`UserBuilder.noAuthentication`, and the permission classifier is a placeholder for an external
channel. What it is for is watching the protocol work with nothing in the way.

## Source layout

```
bin/
  ambassyctl        Installs and drives both processes as services (launchd / systemd)
service/            The unit templates it renders
src/
  agent.ts          A2A server with a placeholder executor: environment, card, port
  revisor.ts        That executor's logic — text statistics and the events it publishes
  parts.ts          The Part/Message helpers both servers build their events out of
  client.ts         A2A client: discovery, streaming, resuming a task
  proxy.ts          Wire-tap that prints raw JSON-RPC and SSE frames
  raw.sh            The same protocol over bare curl
  acp/
    agent.ts        The bridge's bootstrap: backend, handshake, card, port
    executor.ts     The translation: one A2A task becomes one ACP prompt turn
    client.ts       Adapter subprocesses, sessions, idle reaping
    sandbox.ts      Where a conversation may work, and who created that directory
    permissions.ts  The permission classifier and the fs/* handlers
    log.ts          Two rotating JSON Lines logs
  mcp/
    server.ts       MCP endpoint over Streamable HTTP, bearer-guarded
    a2a.ts          The A2A client pool the tools call
    tools.ts        The four tools and how their results are shaped
    auth.ts         Token minting and the constant-time guard
    heartbeat.ts    Progress ticks derived from upstream liveness
tests/              Vitest suites mirroring src/, with fixtures in tests/helpers/
```

Start with the Revisor in `src/agent.ts` if you want to see the protocol with nothing else in the
way: it has no external dependencies and no model behind it, so what remains is A2A itself.
