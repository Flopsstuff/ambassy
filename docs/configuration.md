# Configuration

## Commands

| Command | What it starts |
|---|---|
| `yarn agent` | The Revisor: A2A on `:41241`, no model behind it |
| `yarn agent:claude` | The bridge with `claude-agent-acp` |
| `yarn agent:codex` | The bridge with `codex-acp` |
| `yarn client` | SDK client: two-turn conversation with streaming |
| `yarn raw` | The same protocol over bare curl, no SDK |
| `yarn tap` | Wire-tap proxy `:41242 → :41241` |

All three servers listen on the same port and serve the same protocol, so the client, the raw
script and the tap work against any of them unchanged. They also bind the same interface:
`127.0.0.1`, because an A2A server here runs `UserBuilder.noAuthentication` and a wider bind puts
a coding agent on the network with nothing in front of it. `HOST=0.0.0.0` opens one up when that
is what you want — the MCP bridge is the side meant to face a network, and it has a token.

To watch the traffic, three terminals:

```bash
PUBLIC_URL=http://localhost:41242/ yarn agent:claude   # advertise the tap's address in the card
yarn tap
AGENT_URL=http://localhost:41242 yarn client
```

`PUBLIC_URL` is what the client dials: it takes its address from `supportedInterfaces[].url` in the
Agent Card rather than from wherever it fetched the card. Hence the substitution above — without it
the client connects directly and bypasses the proxy. Hence also the rule whenever `HOST` moves:
the card has to advertise an address the caller can actually reach, so `HOST=0.0.0.0` alone leaves
the card pointing at `0.0.0.0` and a remote client with nowhere to go.

## Environment

Copy `.env.example` to `.env`. The two bridges read it; `src/agent.ts` does not, and takes `PORT`,
`HOST` and `PUBLIC_URL` from the environment alone. Loaded with Node's own `process.loadEnvFile`,
so there is no `dotenv` dependency, and a missing file is not an error.

Two things about that loader are worth knowing, both verified rather than assumed:

- **A shell variable wins over the file.** `process.loadEnvFile` does not overwrite a key already
  present in the environment, so `HOST=0.0.0.0 yarn agent:claude` overrides `.env` for one run.
- **A blank value means unset.** A key left empty in `.env` arrives as `''`, which is a value and
  not `undefined` — so these are read with `||`, not `??`, and fall through to the default. Before
  that, the `LOG_DIR=` line shipped in `.env.example` reached `mkdirSync('')` and killed the server
  before it listened. Four keys keep `??` because blank is a real answer there: `ACP_CWD`,
  `A2A_AGENTS`, `MCP_ALLOWED_HOSTS` and `MCP_TOKEN`.

| Variable | Default | Effect |
|---|---|---|
| `AGENT_NAME` | empty | What the agent answers to: the `name` in the Agent Card, and the `serverInfo` the MCP bridge returns at `initialize`. Empty keeps `Claude (via ACP)` / `Codex (via ACP)`, `Revisor` for the stub and `ambassy-mcp` for the bridge |
| `ACP_CWD` | empty | Where the agent may work; must be an existing directory. Empty means a disposable directory per conversation under `.acp-sandboxes/`. Setting it makes the root *not ours*, which tightens the classifier — see [permissions](permissions.md) |
| `ACP_ALLOW_EXECUTE` | empty | `true` permits shell and network even in a root you supplied |
| `ACP_IDLE_TIMEOUT_MS` | `300000` | How long a conversation may sit idle before its adapter is stopped. A task in `INPUT_REQUIRED` holds its adapter regardless |
| `PORT` | `41241` | Port to listen on |
| `HOST` | `127.0.0.1` | Interface to bind. Loopback by default because there is no authentication on the A2A side at all; `0.0.0.0` exposes the agent to the network |
| `PUBLIC_URL` | `http://$HOST:$PORT/` | The address advertised in the Agent Card. Must name an address callers can reach, so it moves with `HOST` |
| `LOG_DIR` | `logs/` | Where the two JSON Lines logs go |
| `LOG_MAX_BYTES` | `5000000` | Rotation threshold per channel |
| `LOG_MAX_FILES` | `5` | Files kept per channel, the live one included |
| `APP_SERVER_LOGS` | empty | Codex swallows its child's stderr unless this names a directory |
| `CLAUDE_AGENT_LOGS` | empty | Directory for the Claude adapter's own log file |
| `CODEX_CONFIG` | empty | Extra codex configuration as JSON. Note it cannot change the sandbox policy |

`ACP_AGENT` is not in `.env` — it comes from the launch script, which is the whole point of having
two of them.

`AGENT_NAME` is the one key here that crosses all three processes, because from a caller's side
there is only one thing being named: discovery reads the card's `name`, an MCP client reads
`serverInfo`, and an agent that announced two different names in the two places would be a puzzle
rather than a distinction. On the card it replaces the whole default, not just the backend label —
`(via ACP)` is true of every instance of this bridge, so it separates none of them, while the
backend behind it stays visible in the card's description and skill tags. The stub is the usual
exception: `src/agent.ts` reads no `.env`, so there the name comes from the shell or from the
service unit, which `ambassyctl install --backend revisor` copies out of `.env` for you.

## Files that are not committed

`.gitignore` covers `node_modules/`, `.env`, `logs/`, `.acp-sandboxes/`, `temp/` and `ref/`.
`yarn.lock` and `.yarnrc.yml` **are** committed: the first pins SDK versions, and protocol
differences between versions are half the point of this repository; the second holds `nodeLinker`,
without which nothing resolves.

## Package manager

Yarn 4 (Berry), pinned by the `packageManager` field; Corepack resolves it, so a fresh checkout
needs only `yarn install`. Two settings in `.yarnrc.yml` are deliberate:

- `nodeLinker: node-modules` — **not** the default Plug'n'Play. `tsx` resolves imports through its
  own esbuild loader, which cannot read a PnP map, so every command would die on its first import.
- `enableGlobalCache: true` — keeps the package cache out of the repository.

Yarn also refuses versions published less than 24 hours ago and runs no install scripts unless a
package is allowlisted. Both are supply-chain defaults worth keeping; see
[troubleshooting](troubleshooting.md) if an install fails because of them.

There is no build step: `tsx` executes TypeScript directly and the absence of `tsconfig.json` is
deliberate. There are no tests and no linter either — verification is running `yarn client`
against a live agent and checking the cycle.
