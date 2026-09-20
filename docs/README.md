# Documentation

**Ambassy** is a sandbox for the **A2A Protocol v1.0** with a working bridge on top of it: the same
A2A interface, but answered by a real coding agent over **ACP** instead of by a placeholder.

Three protocols meet here, and the first two are easy to confuse because both are JSON-RPC:

- **A2A** (Agent2Agent) is horizontal — one agent delegates a *task* to another over HTTP. The
  task is addressable, has a lifecycle, and survives the call that created it.
- **ACP** (Agent Client Protocol) is what an editor speaks to a coding agent over stdin/stdout.
  There the roles are reversed: the agent is a child process, and we are the client.

- **MCP** (Model Context Protocol) points the other way: it is how a calling agent reaches tools,
  and it is what publishes this A2A agent to Claude Code as something callable.

The bridge sits between them. Everything in these pages was checked against running code, not
inferred from specifications — where behaviour and documentation disagreed, the observed
behaviour is what is written down, and the disagreement is called out.

## Pages

| Page | What it covers |
|---|---|
| [architecture.md](architecture.md) | How the pieces fit, the process model, what lives how long |
| [a2a.md](a2a.md) | The A2A side: cards, task lifecycle, streaming, and the invariants that bite |
| [acp-bridge.md](acp-bridge.md) | The ACP side: adapters, sessions, and how their events become A2A events |
| [mcp-bridge.md](mcp-bridge.md) | The MCP side: publishing the agent as tools, bearer auth, keeping long calls alive |
| [permissions.md](permissions.md) | Who decides what the coding agent may do, and why not the caller |
| [configuration.md](configuration.md) | Commands, environment variables, files |
| [logging.md](logging.md) | The two log channels, their vocabulary, and rotation |
| [service.md](service.md) | Installing the agent and the bridge as background services |
| [testing.md](testing.md) | The unit tests: what they reach, what they fake, and what they leave alone |
| [troubleshooting.md](troubleshooting.md) | Errors you will actually hit, and what they mean |
| [repository-audit.md](repository-audit.md) | Repository audit, confirmed defects, priorities, and acceptance criteria for fixes |

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
