# Testing

Until now the way to check this repository still worked was to run `yarn client` against a live
agent and watch for `SUBMITTED → INPUT_REQUIRED → WORKING → artifact → COMPLETED`. That is a good
end-to-end check and it stays — but it needs a running server, and for the bridge a logged-in
coding agent, so it says nothing about the paths that are hard to provoke on purpose: a cancel
that arrives before the session exists, a log that rotates mid-record, a permission request whose
options do not include the one the classifier wants.

Those paths are what the unit tests are for.

```bash
yarn test            # one run, about a second
yarn test:watch      # re-runs the affected files as you edit
yarn test:coverage   # the same, with a v8 coverage report
```

## What runs them

**Vitest**, configured in [vitest.config.ts](../vitest.config.ts). It transforms TypeScript with
esbuild — the same engine `tsx` uses to run the servers — so imports keep their `.ts` extensions,
nothing is compiled to disk, and the absence of a `tsconfig.json` stays deliberate rather than
worked around.

Type checking is a separate concern and remains a separate command; see the invocation in
[repository-audit.md](repository-audit.md#reproducing-the-baseline-checks).

## Layout

```
tests/
  helpers/
    a2a.ts          A RequestContext to execute against, and a bus that remembers the events
    logs.ts         A Logs that keeps records in memory instead of on disk
    tmp.ts          Throwaway directories, resolved through symlinks, removed after each test
  acp/
    client.test.ts     The backend table and the supervised-mode rule
    executor.test.ts   The ACP → A2A translation, one row of the table at a time
    log.test.ts        JSON Lines, rotation, and a channel that cannot be written to
    permissions.test.ts The classifier as a security boundary, plus the fs/* handlers
    runtime.test.ts    One turn at a time, the token budget, the idle clock
    sandbox.test.ts    Where a conversation may work, and who decided that
  mcp/
    a2a.test.ts        Aliases, client caching, and flattening a turn into a result
    auth.test.ts       Token minting, the token file, and the bearer guard
    heartbeat.test.ts  Ticking while alive, giving up when not
    tools.test.ts      The four tools and the text they answer with
  parts.test.ts     The Part union both servers build their events out of
  revisor.test.ts   The stub agent: what it computes and the cycle it publishes
  version.test.ts   The version on the card is this repository's own
```

Tests mirror `src/` rather than grouping by kind. A file that answers "what does `permissions.ts`
promise?" is easier to keep honest than one that answers "what edge cases exist?".

## How the world is kept out

No module mocking. Every substitution goes through an argument, which means the seams are visible
in the production code and a reader can see what is replaceable:

| Seam | Where | What it replaces in a test |
|---|---|---|
| `RuntimeSource` / `TurnRuntime` | [src/acp/executor.ts](../src/acp/executor.ts) | The adapter subprocess and its ACP session |
| `A2APoolOptions.createClient` | [src/mcp/a2a.ts](../src/mcp/a2a.ts) | `ClientFactory.createFromUrl`, which fetches a card and negotiates a transport |
| `discoveryTimeoutMs` / `requestTimeoutMs` | [src/mcp/a2a.ts](../src/mcp/a2a.ts) | Deadlines measured in seconds, so a test can pass 20 ms and watch one expire |
| `RegistryOptions.sandboxDir` | [src/acp/client.ts](../src/acp/client.ts) | `.acp-sandboxes/` in the repository |
| `RevisorOptions.stepDelayMs` | [src/revisor.ts](../src/revisor.ts) | The pause that exists so a human sees two WORKING frames |
| `ToolOptions.pool` | [src/mcp/tools.ts](../src/mcp/tools.ts) | The A2A pool behind the four MCP tools |

Two things are faked rather than injected, because they are the environment itself: the clock
(`vi.useFakeTimers`, for the heartbeat and the idle clock) and the filesystem (real temporary
directories, since what is under test *is* path resolution — a mocked `fs` would answer whatever
the test expected, including about symlinks, which is precisely the question).

`console.log` is silenced per file. The servers narrate themselves on purpose; a test run is not
the audience.

## What the tests are actually asserting

Most of them exist because of something that was observed, not imagined:

- **The classifier** ([permissions.test.ts](../tests/acp/permissions.test.ts)) is tested as a
  security boundary: every verdict in both directions, paths that climb out in each spelling,
  symlinks in both directions, a file named `..notes` that is a child and not a parent, and the
  rule that an answer must be an option the agent offered — inventing one makes Claude fail the
  whole turn and makes Codex silently downgrade it to a cancel.
- **The translation** ([executor.test.ts](../tests/acp/executor.test.ts)) walks the table in
  [AGENTS.md](../AGENTS.md) row by row, including the two endings that look like bugs from
  outside: a turn that ends `end_turn` after a cancel still reports `CANCELED`, because the SDK
  refuses a `CancelTask` whose stored state is anything else, and the artifact still goes out
  first so the work is not thrown away.
- **Rotation** ([log.test.ts](../tests/acp/log.test.ts)) checks that every line in every file
  parses on its own. Rotating after a write instead of before is the mistake that produces a
  record no reader can recover.
- **The heartbeat** ([heartbeat.test.ts](../tests/mcp/heartbeat.test.ts)) proves both halves: it
  keeps a slow turn alive, and it lets go of a wedged one instead of holding the call until the
  client's wall-clock limit, roughly 28 hours away.
- **Recovery** ([a2a.test.ts](../tests/mcp/a2a.test.ts), [tools.test.ts](../tests/mcp/tools.test.ts))
  is most of what the MCP suites are about, because most of what can go wrong there leaves work
  running on the other side. A turn that ends without a terminal state is `truncated` and rendered
  as an error rather than as an agent that finished; a broken stream throws a `TurnError` carrying
  the identity; an interruption is answered with a call that names the *task*, since answering
  with the context alone opens a second one beside it. The case with no task id at all has its own
  test, because there the honest answer is that nobody knows whether the work was accepted.
- **Artifact aggregation** ([a2a.test.ts](../tests/mcp/a2a.test.ts)) keeps pieces keyed by
  `artifactId` and respects `append`: concatenating regardless turns two replacements of one
  artifact into `oldnew`, and merges artifacts that were never the same artifact.
- **Sandbox allocation** ([sandbox.test.ts](../tests/acp/sandbox.test.ts)) is driven by ids a
  caller chose — `..`, `/etc`, an empty string — because `owned: true` is the flag that lets a
  shell run, and the directory it describes must be one this process created.

## What is not covered, and why

| Not covered | Why |
|---|---|
| `src/agent.ts`, `src/acp/agent.ts`, `src/mcp/server.ts` | Entry points. Importing one reads the environment, builds an Agent Card, probes an adapter and binds a port. What was worth testing in them now lives in the modules they import |
| `src/client.ts`, `src/proxy.ts` | The demonstration client and the wire-tap: both exist to be watched, and both are exercised by the manual cycle above |
| `AcpRegistry.acquire` / `handshake` / the reaper | They spawn a subprocess. Covering them honestly needs a fake ACP adapter on stdin/stdout — worth doing, and the next thing to add |
| `bin/ambassyctl` | A shell script that installs launchd and systemd units; testing it means installing them |

Coverage at the time of writing: 89% of statements over `src/`, with everything except
`src/acp/client.ts` above 93%. That last file is the subprocess lifecycle, which the row above
explains.

## Adding to them

Two habits keep this suite worth reading:

- **Assert the behaviour, not the implementation.** `states()` and `said()` in
  [tests/helpers/a2a.ts](../tests/helpers/a2a.ts) exist so a test reads like the cycle a client
  observes, rather than like a list of `publish` calls.
- **Say why the case exists.** Half of these tests encode a protocol rule or a defect that was
  once real; a comment naming it is what stops someone deleting the test when it becomes
  inconvenient.
