# Troubleshooting

## `-32009 VERSION_NOT_SUPPORTED`

A raw HTTP call without the `A2A-Version: 1.0` header. The server then treats the caller as a v0.3
client. Add the header; `src/raw.sh` triggers this on purpose in step 2 so you can see the error
shape once.

## `-32002 TASK_NOT_CANCELABLE`

Either the task had already reached a terminal state before the cancel arrived — which is correct
behaviour — or the executor did not end it as `CANCELED`. The SDK drains the event bus after
calling the executor and insists on `CANCELED` in the store; see
[the contract](a2a.md#the-canceltask-contract).

## The agent answers, but the classifier never says anything

Expected in two situations. Claude Code's own allowlist passes safe commands without asking, and
the bridge only sees requests that actually reach it. And if `ACP_CWD` is unset the root is one the
bridge created, where shell and unverifiable edits are permitted outright.

If you want to see refusals, point `ACP_CWD` at a directory and ask for something outside it.

## Everything the agent tries to run is refused

You set `ACP_CWD`, so the root is *not* ours and `execute` is denied by default. Set
`ACP_ALLOW_EXECUTE=true` in `.env` and restart, or drop `ACP_CWD` and use the per-conversation
sandboxes.

## `-32000` / "is not authenticated"

The underlying CLI is not logged in. Codex refuses at `session/new`, Claude waits until the prompt,
so the same condition surfaces at different moments. Log in with the backend's own CLI and restart
the bridge.

## Codex misbehaves and says nothing

`codex-acp` is nearly silent, and the stderr of the `codex app-server` child it spawns is swallowed
into a file logger that is disabled by default. Set `APP_SERVER_LOGS=/some/dir` in `.env` and look
there.

## The server will not start: port already in use

`pkill -f "tsx agent.ts"` does **not** kill the server. `tsx` spawns a child process whose command
line does not contain that string, and the child is the one holding the socket. Kill by port:

```bash
lsof -nP -iTCP:41241 -sTCP:LISTEN -t | xargs kill
```

## `yarn install` fails: "All versions satisfying … are quarantined"

Yarn 4 refuses package versions published less than 24 hours ago (`npmMinimalAgeGate`, 1440
minutes). The version is simply too fresh. Wait it out, or relax the range in `package.json` so an
older version satisfies it. Do not turn the gate off — it is a supply-chain default worth keeping.

## `yarn install` fails on the TypeScript compat patch

Yarn applies a built-in patch to the `typescript` package, and older Yarn versions cannot patch
TypeScript 7 (`ENOENT … lib/_tsc.js`). Upgrade Yarn; 4.18.0 handles it. A `resolutions` entry does
not help, because the compat plugin rewrites the descriptor after resolutions are applied.

## `esbuild lists build scripts, but all build scripts have been disabled`

Harmless. Yarn 4 does not run install scripts by default; esbuild still works, because its native
binary comes from a platform-specific package rather than from the postinstall.

## A denied edit ends the task as `CANCELED` rather than continuing

On file edits Codex offers no "decline this one tool" option — only cancelling the whole turn. The
bridge picks the gentlest refusal available, and there it is the only one. The reason travels with
the status message.
