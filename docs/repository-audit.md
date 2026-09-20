# Repository audit and remediation plan

Reviewed on 2026-09-20 against commit `ef99c6a`.

The normal Revisor conversation works, but the surrounding bridges have defects in
directory isolation, cancellation, process ownership, configuration, and result handling.
Fix those before extending the demo. This document records findings and acceptance criteria;
it does not implement the fixes.

## Scope and evidence

Reviewed every tracked source file, package metadata and lockfile, repository configuration,
agent guidance, and all existing documentation. Inspected the installed SDK code where the
bridge depends on lifecycle behavior. Checked protocol claims against the
[A2A v1.0 specification](https://a2a-protocol.org/v1.0.0/specification/).

Validation used Node `v23.8.0`, Yarn `4.18.0`, and the installed dependencies. Temporary
fixtures lived outside the repository. No real Claude or Codex prompts were submitted.

| Check | Result |
|---|---|
| SDK client against live Revisor, isolated port | Passed: `SUBMITTED → INPUT_REQUIRED → WORKING → artifact → COMPLETED` |
| `src/raw.sh` against live Revisor | Passed, including the intentional version-negotiation error |
| `bash -n src/raw.sh` | Passed |
| Explicit TypeScript strict check | Failed: 30 diagnostics in four source files |
| MCP A2A pool against live Revisor | Confirmed incorrect continuation and hanging cancellation of a parked task |
| Controlled HTTP discovery endpoint | Confirmed abort does not settle a call waiting for discovery |
| Fake ACP subprocesses | Confirmed duplicate acquisition, orphaned processes, and unsafe mode fallback |
| Extracted ACP executor with controlled runtime | Confirmed cancellation targets the active task when a queued task is canceled |
| Direct configuration, path, logger, and stream fixtures | Confirmed the cases described below |

The executor fixture copied the existing class into a temporary module, removed server startup,
and replaced the prompt implementation with controlled promises. This checks scheduling and
cancellation routing; it does not establish behavior of the actual model adapters.
The MCP HTTP transport, actual adapter authentication, model execution, and a dependency
vulnerability scan were not exercised.

Priority meanings: **P0** = isolation boundary bypass; **P1** = fix before routine bridge use;
**P2** = correctness or reliability work; **P3** = smaller edge case. Evidence is marked
**reproduced** or **source review**. Source locations refer to the reviewed commit.

## Findings

### F01 — P0: Client-controlled context IDs become trusted filesystem roots

**Location:** [src/acp/client.ts](../src/acp/client.ts), `boundaryFor`, lines 284–301.
**Evidence:** reproduced, plus live verification that the A2A SDK accepts `contextId: ".."`.

`join(SANDBOX_DIR, contextId.slice(0, 8))` uses untrusted text as a directory name and then marks
the result `owned: true`. Calling `boundaryFor("..")` returned the repository root, with
`owned: true` and `allowExecute: false`. The classifier nevertheless permits execution in an
owned root. An arbitrary existing directory reached this way is not a disposable sandbox.
Two distinct contexts with the same first eight characters also share a directory, and an
existing symlink at that name is followed by `realpathSync` and trusted.

**Fix:** allocate directories with `mkdtemp` under the repository's sandbox parent and keep an
explicit context-to-directory mapping. Never derive a trusted path directly from the context
ID or infer ownership from `mkdir({ recursive: true })` succeeding. Keep full identifiers for
identity; shorten them only for display. Verify containment and directory identity before use.

**Acceptance:** `..`, `../..`, separators, matching eight-character prefixes, and pre-existing
symlinks cannot escape the sandbox parent or merge two contexts. No test should execute a
command or write a file outside its disposable fixture.

### F02 — P1: The unauthenticated A2A server binds beyond localhost

**Location:** [src/acp/agent.ts](../src/acp/agent.ts), lines 609–623;
[src/agent.ts](../src/agent.ts), lines 248–260;
[src/proxy.ts](../src/proxy.ts), line 58. **Evidence:** source review.

Both A2A servers call `app.listen(PORT)` without a host while printing a localhost URL.
The tap does the same. On a machine with reachable network interfaces, callers can reach
the coding agent directly, bypassing the bearer guard on MCP. The advertised URL does not
constrain the listening socket. Lack of authentication is an explicit demo choice; exposing
that demo beyond loopback by default is the defect.

**Fix:** default all demo listeners to explicit loopback. Make remote binding an explicit
setting, document the trust boundary, and require an appropriate access control arrangement
for a remote coding-agent endpoint. Treat the proxy as another entry point.

**Acceptance:** default listeners are loopback-only; changing `PUBLIC_URL` never widens them.
Verify the actual bound address, not just the startup message.

### F03 — P1: Copying the supplied environment template breaks startup

**Location:** [.env.example](../.env.example), lines 20 and 32;
[src/acp/agent.ts](../src/acp/agent.ts), lines 51–62;
[src/mcp/server.ts](../src/mcp/server.ts), lines 40–68. **Evidence:** reproduced.

The template sets `LOG_DIR=` and `PUBLIC_URL=`. Nullish coalescing preserves empty strings,
so the logger receives `dir: ""` and throws `ENOENT`. After fixing only that value, the ACP
card still advertises an empty interface URL. Both contradict the documented defaults.

**Fix:** normalize blank optional values before applying defaults, or comment out optional
assignments in the template. Validate the resulting absolute interface URL. Keep intentionally
empty settings such as `ACP_CWD` explicit in the configuration schema.

**Acceptance:** loading an unchanged copy of `.env.example` selects the documented log directory
and a valid public URL. Test this in isolation without overwriting the operator's `.env`.

### F04 — P1: Concurrent acquisition creates two adapters for one context

**Location:** [src/acp/client.ts](../src/acp/client.ts), `acquire`, lines 305–364.
**Evidence:** reproduced with two simultaneous acquisitions and a fake ACP adapter.

The registry is populated only after several awaited startup requests. Both callers can miss
the map, spawn a process, and create a session. The second insertion hides the first runtime.
Observed: two spawns, two different runtimes, registry size one; after `disposeAll()`, the first
process was still alive. Prompts also lose the promised single queue and shared memory.

**Fix:** register an in-progress acquisition promise before the first await. All callers for
that context must share it. Remove a failed promise safely and include pending acquisitions
in shutdown ownership.

**Acceptance:** many concurrent acquisitions produce one process, one session, and one runtime.
A failed acquisition can be retried, and shutdown leaves no pending or hidden children.

### F05 — P1: Failed startup leaks adapter processes; startup has no deadline

**Location:** [src/acp/client.ts](../src/acp/client.ts), lines 127–135, 250–281, 314–364.
**Evidence:** failed acquisition reproduced; missing deadlines found by source review.

If initialize, session creation, or mode selection rejects, `acquire()` has no cleanup block.
A fixture rejecting `session/new` left a live process with registry size zero, even after
`disposeAll()`. A nonresponsive adapter can also hold initialization or session creation
indefinitely. The startup probe's `finally` does not help until its request settles.

**Fix:** own child, connection, and session resources from spawn onward; dispose partial
initializations on every failure. Add bounded startup requests and cancellation-aware prompt
deadlines. Handle spawn failure explicitly: a child that never spawns need not emit `exit`,
which is currently the only event awaited by `stop()`.

**Acceptance:** failures at spawn, initialize, session creation, and mode selection leave no
child or connection behind. A silent fixture fails within a configured deadline; shutdown
also completes when spawn fails.

### F06 — P1: Canceling a queued task cancels the task currently running

**Location:** [src/acp/agent.ts](../src/acp/agent.ts), lines 143–161, 199–241;
[src/acp/client.ts](../src/acp/client.ts), lines 193–214. **Evidence:** reproduced with controlled turns.

Tasks A and B share a runtime; A is running and B is queued. Both are in `runtimeByTask`.
Canceling B sends ACP's session-wide cancel, which targets A. B passed the cancellation check
before entering the queue and is still prompted when it starts. Observed trace:
`prompt A → cancel active A → prompt B` after requesting cancellation of B.

**Fix:** track queued and active task IDs separately. Check the cancellation flag inside the
queued callback immediately before prompting. Send `session/cancel` only when the requested
task is the runtime's active task; settle a canceled queued task without executing it.

**Acceptance:** canceling B never affects A, B never reaches ACP, and B reaches `CANCELED`.
Also cover cancellation during acquisition and a cancel racing normal completion.

### F07 — P1: Canceling an INPUT_REQUIRED task hangs

**Location:** [src/agent.ts](../src/agent.ts), lines 114–118, 137–153;
[src/acp/agent.ts](../src/acp/agent.ts), lines 143–161, 202–218, 257–263.
**Evidence:** live Revisor reproduction and ACP executor bookkeeping fixture.

After an empty input, `execute()` returns. Both cancel implementations merely set a flag or
notify ACP; neither publishes a terminal event for that parked task. The installed SDK keeps
its event bus alive and waits for a terminal event in `cancelTask()`. The live call did not
settle before the fixture's 750 ms timeout, and source inspection shows no remaining producer.
In ACP, `runtimeByTask` has already been deleted, while `openTasks` still pins the adapter.
An early cancel with empty input is also missed because the empty-input branch precedes the
cancellation check.

**Fix:** use the event bus supplied to `AgentExecutor.cancelTask` and retain enough task/context
state to publish `CANCELED` for parked tasks. Release the open-task reference and cancellation
state. Honor an early cancellation before taking the empty-input branch.

**Acceptance:** canceling a parked task returns promptly with stored state `CANCELED`, closes
the relevant stream, releases its adapter retention, and permits idle reaping. Cover both
executors and cancellation during startup with empty input.

### F08 — P1: Missing supervised modes silently retain an unsafe default

**Location:** [src/acp/client.ts](../src/acp/client.ts), `superviseMode`, lines 367–385.
**Evidence:** reproduced with an adapter offering only `auto`.

When the required mode is unavailable, the bridge logs a message and continues in the current
mode. The fixture created usable sessions in `auto`. That defeats the stated reason for
forcing a mode: routing permission decisions through the bridge.

**Fix:** fail session creation when the required supervision mode cannot be established, then
clean up the adapter. If alternate modes are supported later, map them explicitly by verified
behavior. Do not grant `switch_mode` merely because a directory is owned without checking
whether the proposed mode preserves supervision.

**Acceptance:** missing modes and rejected mode changes prevent prompting and leave no process.
Known supported modes continue to work.

### F09 — P1: MCP cannot resume a task that needs more input

**Location:** [src/mcp/a2a.ts](../src/mcp/a2a.ts), lines 71–79, 119–143;
[src/mcp/tools.ts](../src/mcp/tools.ts), lines 54–60, 99–105. **Evidence:** live reproduction.

`a2a_ask` accepts `contextId` but not `taskId`; every outgoing message has `taskId: ""`.
Its own response instructs the caller to answer using only `contextId`. Following that advice
creates a new task. In the fixture, the second task completed while the first remained
`INPUT_REQUIRED`. With ACP that abandoned task also keeps a runtime alive.

**Fix:** add an optional `taskId` throughout the tool schema and pool API. Return continuation
instructions containing the actual task ID and context. Preserve the ability to start a new
task in an existing context when no task ID is supplied.

**Acceptance:** an input-required round trip retains one task ID, accumulates history on that
task, and eventually releases its open-task reference. See the specification's
[task continuation semantics](https://a2a-protocol.org/v1.0.0/specification/#343-multi-turn-conversation-patterns).

### F10 — P1: The advertised recovery path loses the task handle on errors

**Location:** [src/mcp/a2a.ts](../src/mcp/a2a.ts), `AskUpdate` and `ask`;
[src/mcp/tools.ts](../src/mcp/tools.ts), lines 138–145, 155–158. **Evidence:** source review.

Task IDs are collected only inside the pool's local result. Progress says `task accepted`
without IDs, and the error path returns only a failure string. If the stream fails after
acceptance, the caller has no handle for `a2a_task` or `a2a_cancel`. On the first conversation,
it may not know the context either. Disconnecting from an A2A stream is not a reliable way to
cancel the underlying task.

**Fix:** propagate identity with the first update and preserve it in typed errors and timeout
responses. Define how a caller without progress notifications recovers after a disconnected
request, for example through an explicit correlation mechanism. State whether interruption
leaves work running or requests cancellation; preserve the existing blocking tool design.

**Acceptance:** a forced disconnect after task acceptance leaves the caller with a usable
recovery path. A silence timeout includes the known agent, task ID, and context ID.

### F11 — P1: Discovery bypasses the MCP abort gate

**Location:** [src/mcp/a2a.ts](../src/mcp/a2a.ts), lines 103–109, 124–125, 184–205;
[src/mcp/tools.ts](../src/mcp/tools.ts), lines 115–145. **Evidence:** reproduced with stalled HTTP discovery.

The abort signal is passed only to `sendMessageStream`, after awaiting `createFromUrl`.
Aborting while the card request was held open did not settle `ask`; it remained pending until
discovery was released. `task`, `cancel`, and `card` also expose no request cancellation or
explicit deadline, so the heartbeat's guarantee does not cover the whole operation.

**Fix:** bound discovery separately and make each caller's wait abortable. Do not let one
caller's cancellation invalidate a shared discovery needed by others. Propagate cancellation
and finite deadlines to task retrieval, cancellation, and card retrieval too.

**Acceptance:** a server accepting HTTP but never returning its card cannot hold a canceled
tool call indefinitely. Verify the same behavior for each of the four tools and shared discovery.

### F12 — P2: MCP corrupts replacement artifacts and ignores snapshot content

**Location:** [src/mcp/a2a.ts](../src/mcp/a2a.ts), lines 150–170.
**Evidence:** reproduced with an injected SDK stream.

Every artifact update is concatenated regardless of `artifactId` and `append`. Two updates
for the same artifact, `old` then `new`, both with `append: false`, produced `oldnew`.
Artifacts already present in a task snapshot are ignored. Multiple structured parts collapse
to one value, with later updates overwriting it.

**Fix:** aggregate by artifact ID, apply replacement versus append, seed from snapshots, and
preserve parts and artifact boundaries until rendering. Track direct Message responses as a
separate supported outcome. Follow the specification's
[artifact update fields](https://a2a-protocol.org/v1.0.0/specification/#422-taskartifactupdateevent).

**Acceptance:** cover replacement, append, interleaved artifacts, a completed task snapshot,
multiple data parts, and a direct Message response.

### F13 — P2: An incomplete stream is rendered as a successful tool result

**Location:** [src/mcp/a2a.ts](../src/mcp/a2a.ts), lines 146–181;
[src/mcp/tools.ts](../src/mcp/tools.ts), lines 66–69. **Evidence:** reproduced with an injected stream.

A stream that ends after a `WORKING` task returns that state normally. `renderAsk` marks only
`FAILED` and `REJECTED` as errors, so the caller receives an ordinary result saying the agent
finished in `WORKING`. An empty stream similarly returns `UNSPECIFIED`.

**Fix:** validate the stream outcome. Distinguish a valid direct Message, a terminal task,
an interrupted task requiring input/authentication, and an unexpected EOF. Treat the last as
an error carrying recovery identifiers. Make cancellation rendering explicit as well.

**Acceptance:** premature EOF cannot report successful completion; valid Message-only responses
remain supported, and interrupted states tell the caller what action is needed.

### F14 — P2: Final failure reasons and recovery data disappear in MCP results

**Location:** [src/mcp/a2a.ts](../src/mcp/a2a.ts), lines 155–162;
[src/mcp/tools.ts](../src/mcp/tools.ts), lines 46–83. **Evidence:** source review.

Final status text is sent as progress but retained only for `INPUT_REQUIRED`. ACP permission
refusals and authentication errors delivered as `CANCELED` or `FAILED` status messages therefore
vanish from the tool result. `a2a_task` also strips status messages, data parts, and artifact IDs,
so it cannot recover the complete answer or explain the failure.

**Fix:** retain the latest status message and expose it in both ask and task results. Preserve
structured artifact data and identity in retrieval. Choose consistent `isError` semantics for
failed and canceled work without discarding available partial output.

**Acceptance:** a denial reason is visible without progress support; retrieving a task preserves
its text, structured result, and final status explanation.

### F15 — P2: Agent Cards advertise part labels instead of media types

**Location:** [src/agent.ts](../src/agent.ts), lines 230–240;
[src/acp/agent.ts](../src/acp/agent.ts), lines 578–588;
[docs/a2a.md](a2a.md), discovery example. **Evidence:** live card and specification check.

Cards declare `text` and `data`. These fields describe media types, so clients negotiating
`text/plain` or `application/json` receive incorrect capability metadata.

**Fix:** use the actual supported media types in default and skill-specific modes, and update
the example. See the specification's
[Agent Card fields](https://a2a-protocol.org/v1.0.0/specification/#441-agentcard).

**Acceptance:** both cards and documentation agree with the media types of emitted Parts.

### F16 — P2: MCP and ACP rotate the same logs independently

**Location:** [src/acp/agent.ts](../src/acp/agent.ts), lines 58–62;
[src/mcp/server.ts](../src/mcp/server.ts), lines 47–68;
[src/acp/log.ts](../src/acp/log.ts), lines 41–85. **Evidence:** source review.

The expected deployment runs both bridges. They use the same default directory and filenames,
but each process tracks file size independently and renames the same rotation files. Size
accounting becomes stale, rotations compete, and retained history is unreliable. This is not
fixed by the fact that an individual append is synchronous.

**Fix:** give each service separate channel names or default subdirectories. Keep one owner
per rotation set; avoid adding interprocess locking unless shared files are actually required.

**Acceptance:** run both writers past several rotation thresholds. Every expected record is
accounted for within each service's documented retention window.

### F17 — P2: Logging can still throw into bridge control flow

**Location:** [src/acp/log.ts](../src/acp/log.ts), lines 50–60 and 89–92.
**Evidence:** reproduced with an invalid log destination and a non-JSON field.

Directory creation and initial file access are outside error handling. `JSON.stringify` is
also outside the write catch. An unusable destination throws during startup; a BigInt field
throws on a log call. The latter is a robustness fixture, not a claim that current SDK usage
contains BigInt. Both contradict the documented promise that logging cannot take down the bridge.

**Fix:** either implement nonfatal logger initialization and serialization, or explicitly
document a deliberate startup failure policy. Keep subsequent logging failures from changing
task outcomes. Preserve a once-only diagnostic.

**Acceptance:** inaccessible paths and unsupported/circular fields follow the chosen policy
without repeated exceptions or accidental task failure.

### F18 — P2: Environment values are cast instead of validated

**Location:** [src/acp/agent.ts](../src/acp/agent.ts), lines 44–60;
[src/acp/client.ts](../src/acp/client.ts), lines 286–291;
[src/mcp/server.ts](../src/mcp/server.ts), lines 40–59, 73–78. **Evidence:** source review.

`A2A_AGENTS` accepts any syntactically valid JSON, including `null`, arrays, and non-string URLs.
Numeric settings accept `NaN`, negative values, fractions, and empty-string zero. A regular file
passes the `ACP_CWD` existence check. Wider MCP binding proceeds without `MCP_ALLOWED_HOSTS`,
although the template calls that setting required. Alias/backend lookups also use inherited
object properties rather than checking own keys.

**Fix:** validate configuration once at startup with setting-specific errors: valid ports,
positive finite durations and rotation limits, nonempty alias-to-HTTP(S)-URL records, a real
directory for `ACP_CWD`, and the documented host allowlist rule. Use a Map or own-property checks
for caller-supplied aliases and backend names. Format IPv6 endpoint URLs with brackets.

**Acceptance:** a table of malformed and boundary values fails before binding or spawning.
Explicitly test `null`, `[]`, inherited property names, blank values, and non-loopback hosts.

### F19 — P2: Every ACP -32000 error is mislabeled as authentication failure

**Location:** [src/acp/agent.ts](../src/acp/agent.ts), `describeError`, lines 118–124;
[docs/troubleshooting.md](troubleshooting.md), authentication section. **Evidence:** source review.

The code replaces any `RequestError` with code `-32000` with a login instruction, discarding
its original message. An adapter's generic execution/session error can use the same code.
The fake adapter used in this audit can produce such a non-authentication error.

**Fix:** recognize a demonstrated authentication error shape narrowly. Preserve code, original
message, and useful structured details in other cases, with appropriate secret redaction.

**Acceptance:** genuine authentication failures retain helpful guidance; an unrelated `-32000`
failure reports its actual cause.

### F20 — P2: The proxy does not manage stream backpressure or disconnects

**Location:** [src/proxy.ts](../src/proxy.ts), lines 22–55. **Evidence:** source review.

The request body is buffered without a limit. Response chunks are written regardless of
`res.write()` returning false, and downstream closure does not destroy the upstream request.
There is no upstream response error/aborted handler or deadline. A slow or disconnected
observer can leave buffering or an upstream stream active, undermining the tap's transparency.

**Fix:** stream with backpressure-aware piping while retaining bounded observation, or pause
and resume explicitly. Bound captured request bodies, handle aborted/error events on both
sides, and destroy the upstream connection when the downstream closes. Configure a sensible
timeout policy that permits long SSE responses.

**Acceptance:** disconnecting a client closes its proxy connection upstream, a slow reader
does not cause unbounded buffering, and an upstream reset settles the downstream response.

### F21 — P2: Verification does not detect the existing TypeScript and failure-path defects

**Location:** [package.json](../package.json), scripts;
[src/acp/client.ts](../src/acp/client.ts), lines 106–124, 255–269;
[src/client.ts](../src/client.ts), lines 84–108. **Evidence:** compiler run and source review.

An explicit strict check produced 30 diagnostics. Concrete examples include declaring piped
stderr when spawn actually inherits it, accessing an `unknown` initialize response, unchecked
optional SDK fields, and accessing `$case` on an exhausted union. This is separate from the
intentional absence of a build step: `tsx` transpilation does not validate types.

`yarn test` is a permanently failing placeholder. The smoke client also returns exit code zero
when its first turn does not reach `INPUT_REQUIRED`, and does not assert the final state or
artifact count. A printed failure can therefore appear successful to automation.

**Fix:** add a no-emit typecheck with explicit settings and resolve the actual errors. Keep
direct TypeScript execution. Make smoke checks assert their advertised outcome. Add focused
offline regression coverage for this document's lifecycle defects using fake ACP and A2A peers;
no model account is needed.

**Acceptance:** typecheck and smoke commands provide reliable exit codes, and regression cases
fail before their corresponding fixes. Do not make paid model calls part of routine CI.

### F22 — P3: Valid filenames starting with two dots are refused

**Location:** [src/acp/permissions.ts](../src/acp/permissions.ts), lines 86–88.
**Evidence:** reproduced: `insideRoot(process.cwd(), "..notes")` returned false.

`rel.startsWith('..')` rejects ordinary child names such as `..notes` as well as parent traversal.

**Fix:** reject exactly `..` or a path beginning with `..` followed by the platform separator,
plus absolute relative results; retain canonical path checks.

**Acceptance:** `..notes` and `..cache/file` inside the root pass; actual parents, sibling paths,
and symlink escapes fail.

### F23 — P3: LOG_MAX_FILES=1 retains an extra file

**Location:** [src/acp/log.ts](../src/acp/log.ts), `rotate`, lines 78–85.
**Evidence:** reproduced with `maxFiles: 1` and two records forcing rotation.

Rotation removes `.0` and then renames the live file to `.1`, keeping both live and rotated
files even though the documented total is one.

**Fix:** handle retention of one file explicitly, and validate the setting as a positive integer.
Document that one oversized record may exceed the byte threshold without being split.

**Acceptance:** retention values 1, 2, and 5 keep exactly the permitted number per channel after
repeated rotations, and every retained line parses as JSON.

## Follow-up work and documentation corrections

These items should remain visible, but should not displace the concrete defects above:

- **Resource limits:** the in-memory store, pending queues, adapter count, parked tasks, prompt
  output, and filesystem reads have no application bounds. Retaining a parked conversation and
  leaving its files for inspection are documented choices. Add explicit capacity limits and an
  operator cleanup/expiration path without silently forgetting an active task's context.
- **Turn bookkeeping:** `execute()` calls `runtime.endTurn()` outside `Runtime.run`. A previous
  execute's finalizer can overlap the next queued turn's ownership of shared state. Move all
  turn-specific setup and cleanup inside the serialized callback and test log attribution.
- **Session loss:** a dead or reaped adapter is replaced without restoring its ACP history.
  Distinguish continuing a live context from restarting an expired one, and document the idle
  lifetime in the MCP tool description rather than promising unqualified memory retention.
- **Shutdown:** close HTTP listeners before disposing registries; reject new acquisitions,
  settle or bound active requests, await pending cleanup, and handle disposal errors. MCP
  currently exits immediately. Keep this tied to the ownership fixes in F04–F07.
- **Logging claims:** `fs.denied` omits `sessionId`; early cancellation and `task.failed` do not
  consistently contain the promised budget. Either add the fields or narrow the documented
  event contracts. Separate MCP and ACP logs before promising complete audit trails.
- **Permissions wording:** a working directory does not itself contain a shell command.
  Advertising ACP file capabilities does not intercept every possible read/write performed
  by tools or subprocesses. Preserve the existing warning that this classifier is not a sandbox;
  qualify stronger claims elsewhere in README, source comments, and the bridge documentation.
- **Documentation drift:** add MCP to the top-level command/file overview and configuration
  page; correct the claim that `src/mcp/` never imports `src/acp/` (it imports the logger);
  correct `.env.example`'s claim that only ACP loads `.env`; update stale `acp-agent.ts` names;
  remove the claim that `temp/` is ignored unless an ignore entry is added. `historyLength: 0`
  deliberately returns no history, so the demo's final zero count does not demonstrate stored
  conversation history. Distinguish stored terminal tasks from destroyed tasks in the lifetime
  table. Pin client-specific timing claims to tested client versions.
- **Developer setup:** document the supported Node version and required raw-demo tools, add
  an `engines` policy if desired, and remove placeholder package metadata such as a nonexistent
  `index.js` entry point. Keep Yarn and the committed lockfile; adding a build system is not
  required to fix this repository.

Already documented limitations, including process-local persistence, absent A2A authentication,
shared `ACP_CWD`, adapter-controlled approval requests, writable temporary directories, and
symlink check/use races, are not presented here as newly discovered bugs. F01 and F02 are
additional concrete boundary failures despite those limitations.

## Suggested implementation order

1. **Restore safe defaults:** F01–F03 and F08. Add boundary and template regression fixtures.
2. **Fix process/task ownership together:** F04–F07, then turn bookkeeping and shutdown.
3. **Make MCP continuation and recovery real:** F09–F14, with bounded upstream operations.
4. **Correct protocol metadata and operations:** F15–F20, F22–F23, and documentation drift.
5. **Make checks durable:** introduce F21's typecheck and targeted fixtures alongside each fix;
   finish with the live Revisor SDK/raw smoke flows and an explicit optional adapter smoke run.

Suggested regression cases should cover the transitions and failure conditions above rather
than mock the implementation line by line. Preserve the first-event rule and the visible
protocol translation that make this repository useful as a learning sandbox.

## Reproducing the baseline checks

Run the server in one terminal and the clients in another, with no real coding backend:

```bash
PORT=42342 PUBLIC_URL=http://localhost:42342/ yarn agent
AGENT_URL=http://localhost:42342 yarn client
AGENT=http://localhost:42342 yarn raw
```

The raw script currently expects a base URL without a trailing slash.

The compiler invocation used for this review was:

```bash
yarn exec tsc --noEmit --module nodenext --moduleResolution nodenext \
  --target es2023 --allowImportingTsExtensions --skipLibCheck --strict \
  src/agent.ts src/client.ts src/proxy.ts src/acp/*.ts src/mcp/*.ts
```

For the parked cancellation case, send whitespace through `A2APool.ask`, retain its task ID,
then call raw `CancelTask` with an HTTP deadline. For F09, send a second nonempty ask with only
the first result's context ID and compare both task IDs and the original task's stored state.
Use temporary fake adapters for concurrency and startup failure cases; do not test these by
submitting repeated paid prompts to a real backend.
