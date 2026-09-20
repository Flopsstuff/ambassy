# Running as a service

Everything else in these pages assumes you started a process in a terminal and can watch it.
This page is about the other case: the agent lives on a machine you are not sitting at, comes
back after a reboot, and is reached by a client somewhere else on the network.

`bin/ambassyctl` installs it, one command for both service managers:

```bash
./bin/ambassyctl install --with-mcp     # or: yarn service install --with-mcp
./bin/ambassyctl status
```

On macOS that writes LaunchAgents into `~/Library/LaunchAgents`; on Linux, `--user` units into
`~/.config/systemd/user`. Nothing is installed system-wide and nothing needs root — deliberately,
because the coding agent behind the bridge reads the credentials in the operator's home
directory, so it has to run as that user.

## Two units, not one

| Unit | Process | What it is |
|---|---|---|
| `a2a` | `src/acp/agent.ts` (or `src/agent.ts`) | The agent itself: A2A in, a coding agent over ACP out |
| `mcp` | `src/mcp/server.ts` | The MCP endpoint that fronts an A2A agent for a calling agent |

They are separate services, and that is not an accident of packaging. The MCP bridge is an A2A
*client* that reaches the agent over the network — it may legitimately run alone against an
`A2A_URL` on another host — and a crash in one must not take the other down. What makes them feel
like one service is this script, which applies every verb to both by default:

```bash
./bin/ambassyctl install                 # a2a only
./bin/ambassyctl install --with-mcp      # a2a + mcp
./bin/ambassyctl install mcp             # mcp only, fronting a remote A2A_URL
./bin/ambassyctl start|stop|restart      # both, or name one: restart mcp
./bin/ambassyctl status
./bin/ambassyctl logs -f
./bin/ambassyctl uninstall
```

Ordering between them is never enforced. The bridge builds its A2A client lazily, on the first
tool call, so starting before the agent costs nothing: if the agent is down by then the call
fails and the next one tries again. The systemd unit says `After=ambassy-a2a.service` for
tidiness and never `Requires=`; launchd has no ordering between agents at all, and needs none.

## What goes in a unit, and what stays in .env

A unit file carries only what selects the process — the entry point, the absolute path to `node`
and `tsx`, a `PATH`, where to write stdout. Everything else stays in `.env`, which both bridges
read at startup, so changing a port or a timeout is an edit and a `restart`, not a reinstall.

That absolute path to `node` is taken from `process.execPath`, never from `command -v node`, and
the reason is the command at the top of this page: under `yarn service …` Yarn 4 puts a temporary
wrapper first on `PATH` and deletes it when the command ends. A unit built from `PATH` would name
an interpreter that no longer exists, and would hand the ACP adapters the same vanished directory
to resolve their own `#!/usr/bin/env node` against. `AMBASSY_NODE` overrides the choice.

The one exception is the stub executor: `src/agent.ts` reads no `.env` at all, so when it is
installed with `--backend revisor` the script copies `PORT`, `HOST` and `PUBLIC_URL` into the
unit. The `.env` file remains the place you edit them.

This layering works because a variable set in the unit wins: `process.loadEnvFile()` does not
overwrite a key already in the environment. The same rule is what makes `HOST=0.0.0.0 yarn agent`
work from a shell.

Two values the installer will write into `.env` for you, because a service cannot do without
them:

- **`MCP_TOKEN`** — minted once and pinned. Left unset, the bridge mints a fresh token on every
  start, which invalidates the client config that holds the old one; across a restart of a
  *service* that is a guaranteed outage rather than a nuisance. The same value is mirrored into
  `.mcp-token` (mode 600) so `ambassyctl token` and a hand-started `yarn mcp` agree.
- **`A2A_URL`** — pinned to the local agent when both units are installed together. It defaults
  to `http://localhost:41241/`, so a repository that moved `PORT` would otherwise have its bridge
  quietly pointing at nothing.

Neither is touched when it already has a value.

## Choosing the backend

```bash
./bin/ambassyctl install --backend claude    # default
./bin/ambassyctl install --backend codex
./bin/ambassyctl install --backend revisor   # the placeholder executor, no model behind it
```

`claude` and `codex` install `src/acp/agent.ts` and record the choice as `ACP_AGENT` in `.env`;
`revisor` installs `src/agent.ts`, which is useful for proving the plumbing — ports, restarts,
the MCP token — without spending a single token on a model.

Re-running `install` re-renders the units and restarts them, so it is also how you apply a change
of backend or a move of the repository.

## Reaching it from another machine

Both servers bind loopback by default. The A2A agent runs `UserBuilder.noAuthentication`, so
opening it to the network hands a coding agent to anyone who can route to it; the MCP endpoint is
the side meant to face a network, and it has a bearer token in front of it.

```bash
./bin/ambassyctl install --with-mcp --mcp-host 0.0.0.0
./bin/ambassyctl token          # endpoint, token, and a ready .mcp.json block
```

Set `MCP_ALLOWED_HOSTS` when you do this — beyond loopback the SDK's automatic DNS-rebinding
protection is off, and the allowlist is what replaces it. The installer warns when it is missing.
`ambassyctl token` prints the LAN address rather than the bind address, because `MCP_HOST` says
how the socket is bound, not how it is reached.

## Logs

Service logs are the processes' own stdout and stderr, in `logs/service/`:

```
logs/service/a2a.out.log   a2a.err.log
logs/service/mcp.out.log   mcp.err.log
```

`ambassyctl logs [a2a|mcp] [-f]` tails them. These are the human-readable console lines — the
structured record of what the bridge did is still `logs/calls.jsonl` and `logs/work.jsonl`,
which rotate themselves (see [logging.md](logging.md)). The four files here do **not** rotate:
they are a fallback for the case where a process dies before it can log anything structured, and
truncating them is safe at any time.

`install` creates the directory as `0700` and the four files as `0600` before anything starts,
because the MCP bridge prints its bearer token at startup and a service manager creates its
stdout files under its own umask — `0644` on a default system. A manager appends to a file that
already exists without touching its mode, so the moment before the first start is the only one
that decides this.

## launchd notes

- `stop` calls `launchctl bootout`, which unloads the job outright, and `start` bootstraps it
  again. A stopped unit still comes back at the next login, because the plist stays in
  `~/Library/LaunchAgents` and carries `RunAtLoad`. To stop that, `uninstall`.
- `KeepAlive` is `{ SuccessfulExit = false }`, not `true`: a crash is restarted after
  `ThrottleInterval` (10s), but the clean exit that `stop` produces is left alone. With `true`
  the process would come straight back up and `stop` would appear not to work.
- launchd unloads asynchronously. Bootstrapping immediately after a bootout fails with
  `Input/output error 5`, so the script waits for the old job to disappear first.
- A LaunchAgent lives in the user's GUI session, so on a headless Mac the user has to be logged
  in (automatic login, or a console session) for the agent to run.

## systemd notes

- Units are `--user` units, enabled with `--now`, restarted `on-failure` after 10s.
- A user session ends at logout and takes its units with it. `loginctl enable-linger $USER`
  is what keeps them running on a headless host; the installer checks and says so when it is off.
- `KillSignal=SIGTERM` with `TimeoutStopSec=30` for the agent: the executor disposes of its ACP
  adapter subprocesses on SIGTERM, and that deserves room to finish.

## When it does not come up

`ambassyctl status` prints what the service manager thinks (installed, running, pid) next to what
the network thinks — `card ok` means the Agent Card answered on `HOST:PORT`, `guard ok` means the
MCP endpoint answered 401 to an unauthenticated probe, which proves both the listener and the
bearer guard. A process with a pid but no probe is the interesting case; `ambassyctl logs` is the
next step.

| Symptom | Cause |
|---|---|
| `EADDRINUSE` in `a2a.err.log` | A hand-started `yarn agent` is still holding the port |
| `Cannot find module …/tsx` | `yarn install` has not run in this checkout |
| `node: command not found` in the unit | `node` moved (nvm upgrade). Re-run `install` — the path is baked in at install time |
| `guard ok` but every tool call fails | The bridge is up and the agent is not; check `A2A_URL` against `ambassyctl status` |
| Restart loop every 10s | The process exits non-zero at startup; the reason is in `*.err.log` |
