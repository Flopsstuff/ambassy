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
script and the tap work against any of them unchanged.

To watch the traffic, three terminals:

```bash
PUBLIC_URL=http://localhost:41242/ yarn agent:claude   # advertise the tap's address in the card
yarn tap
AGENT_URL=http://localhost:41242 yarn client
```

`PUBLIC_URL` exists for exactly this: the client takes its address from `supportedInterfaces[].url`
in the Agent Card, so without the substitution it connects directly and bypasses the proxy.

## Environment

Copy `.env.example` to `.env`. Only the bridge reads it; `src/agent.ts` needs nothing. Loaded with
Node's own `process.loadEnvFile`, so there is no `dotenv` dependency, and a missing file is not an
error.

| Variable | Default | Effect |
|---|---|---|
| `ACP_CWD` | empty | Where the agent may work. Empty means a directory per conversation under `.acp-sandboxes/`. Setting it makes the root *not ours*, which tightens the classifier — see [permissions](permissions.md) |
| `ACP_ALLOW_EXECUTE` | empty | `true` permits shell and network even in a root you supplied |
| `ACP_IDLE_TIMEOUT_MS` | `300000` | How long a conversation may sit idle before its adapter is stopped. A task in `INPUT_REQUIRED` holds its adapter regardless |
| `PORT` | `41241` | Port to listen on |
| `PUBLIC_URL` | `http://localhost:$PORT/` | The address advertised in the Agent Card |
| `LOG_DIR` | `logs/` | Where the two JSON Lines logs go |
| `LOG_MAX_BYTES` | `5000000` | Rotation threshold per channel |
| `LOG_MAX_FILES` | `5` | Files kept per channel, the live one included |
| `APP_SERVER_LOGS` | empty | Codex swallows its child's stderr unless this names a directory |
| `CLAUDE_AGENT_LOGS` | empty | Directory for the Claude adapter's own log file |
| `CODEX_CONFIG` | empty | Extra codex configuration as JSON. Note it cannot change the sandbox policy |

`ACP_AGENT` is not in `.env` — it comes from the launch script, which is the whole point of having
two of them.

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
