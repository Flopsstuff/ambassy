# Logging

Two files under `logs/`, JSON Lines, rotated by size. Implemented in `src/acp/log.ts`.

## Why two, and why by hand

The two channels have different readers. `calls.jsonl` answers *what did we call outside, and what
did it cost*; `work.jsonl` answers *what did the agent do inside a turn, and what was it allowed to
do*. Merging them would force both readers to filter out the other's records.

The format is JSON Lines because half of what is recorded is structured — token counts, tool-call
records, the paths a permission decision turned on. Prose would make whoever reads it later parse
English back into numbers.

It is written by hand rather than taken from a logging library for the same reason `src/proxy.ts`
is: appending a line, counting bytes and renaming files is the entire job, and a library would
hide it behind transports and levels without making it more correct here.

## `calls.jsonl` — the outward boundary

| Event | Carries |
|---|---|
| `handshake`, `handshake.failed` | the startup probe: agent name and version, protocol version, auth methods, capabilities |
| `adapter.spawn` | pid, backend, cwd, whether the root is ours |
| `session.new` | session id, cwd, the mode settled on, available modes, duration |
| `adapter.failed` | a start that got no further: which stage it died at, and the adapter stopped again |
| `task.start` | `resuming`, request length |
| `task.input_required` | the task parked awaiting input |
| `prompt.start` | session id, request length |
| `prompt.stop` | duration, `stopReason`, tool counts, failed tools, refusals, **`usage` and `budget`** |
| `task.cancel` | which phase: `no-session` or `session/cancel` |
| `task.failed` | the reason, already made human-readable |
| `task.finish` | final state, `stopReason`, budget |
| `adapter.exit` | exit code or signal, and the conversation's final budget |
| `adapter.reap` | idle time and the final budget |

## `work.jsonl` — what the agent did

| Event | Carries |
|---|---|
| `tool.call` | tool call id, title, kind, status, locations |
| `tool.update` | tool call id, the new status — only when it actually changed |
| `plan` | the entries with their statuses |
| `permission` | decision, reason, paths, the chosen `optionId`, and **every option the agent offered** |
| `fs.read`, `fs.write` | path relative to the root, byte count |
| `fs.denied` | the path that escaped the root |

Recording the offered options matters: answering with an id the agent never offered is the one
mistake that must not happen, and the log is what lets you check afterwards that it did not.

## Correlation

Every record carries `ts` and `event`. Work records also carry `contextId`, `taskId` and
`sessionId`, so a permission decision can be traced back to the task that provoked it. The
`taskId` comes from state the runtime keeps for the turn in flight, which is sound only because
`Runtime.run` allows one turn per conversation at a time.

## Token budget

`usage` is one turn's cost, straight from the ACP `PromptResponse`. `budget` is the conversation's
running total, accumulated on the runtime:

```jsonc
"usage":  { "inputTokens": 2, "outputTokens": 2384, "cachedReadTokens": 12681,
            "cachedWriteTokens": 16716, "totalTokens": 31783 }
"budget": { "turns": 1, "totalTokens": 31783, … }
```

A conversation is several turns, and only the running total says what it cost. The budget is also
attached to `adapter.exit` and `adapter.reap`, so the final figure survives even if nobody was
watching when the conversation ended.

## Rotation

At `LOG_MAX_BYTES` the live file becomes `calls.1.jsonl`, the previous `.1` becomes `.2`, and the
oldest beyond `LOG_MAX_FILES` is dropped. Rotation happens **before** a write, never after: a
record split across two files is a record no reader can parse.

A failed write — full disk, no permissions — is reported once to stderr and then the channel goes
quiet. Logging must not be able to take down the thing it is logging.

Both files are created empty at startup, so a reader never has to special-case a channel that
has not been written to yet — `work.jsonl` stays empty through a run of pure conversation.

## Reading them

```bash
# how much each conversation has cost
jq -r 'select(.event=="prompt.stop") | [.contextId[0:8], .stopReason, .budget.totalTokens] | @tsv' logs/calls.jsonl

# everything the classifier refused, with its reason
jq -r 'select(.event=="permission" and .decision!="allow") | [.taskId[0:8], .title, .reason] | @tsv' logs/work.jsonl

# one task end to end, both channels, in time order
jq -c 'select(.taskId=="<id>")' logs/calls.jsonl logs/work.jsonl | sort
```
