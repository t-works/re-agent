# Future: orchestrator-created agents, loaded mid-session

Today the sub-agent roster is fixed at CLI boot: `createOrchestrator()` scans
`agents/` once (`loadRegistry()`), bakes the roster into the system prompt
(`system.txt` `{agents}` replacement) and the `delegate` tool description, and
all three freeze in closures. Adding an agent mid-session is therefore
impossible twice over:

1. **Registry snapshot** — new dirs under `agents/` are never re-scanned; the
   orchestrator never learns they exist.
2. **Compiled entry requirement** — `delegate()` spawns
   `dist/agents/<DIR>/agent.js`; a new agent needs authored TS + `npm run
   build` before it is spawnable. The existing per-agent entries
   (CONFIG-EDITOR/agent.ts, VISION/agent.ts) are ~90% identical boilerplate
   differing only in the toolset they hand `reactLoop`.

## The unblock: agents become data

- **One generic runner.** Collapse the entry boilerplate into a single
  compiled runner that derives everything from `agent.json` + `system.txt`
  (both data). `agent.json` gains a validated `tools: string[]` field (subset
  of the shared pool: `run_command`, `run_ssh`, `view_image`, memory tools).
  Spawn = `node dist/<runner> <agentSrcDir> <taskDir>` — no per-agent build.
  Deletes two agent.ts files of boilerplate. Custom per-agent code remains
  possible only when a tool needs its own implementation (opt out of the
  generic runner).
- **Live registry.** `ask()` is stateless (full history rides in `input` every
  request), so nothing depends on the boot snapshot: rebuild roster / system
  prompt / delegate description per turn from a re-scannable registry. Cheap —
  system.txt is ~30 lines. `finalize()`'s writer list reads the same registry.
- **`create_agent` tool** on the orchestrator: model passes name, description,
  `tools`, and the sub-agent's system prompt; the tool writes
  `agents/<name>/{agent.json,system.txt}` and registers. Meta — the
  orchestrator authors a prompt for its own specialist.

## Open questions / safety

- **Tool access = privilege.** A created agent with `run_command`/`run_ssh`
  is a new command-capable principal, yet local `run_command` is not
  ask-gated today (ask rules are ssh-scoped). Consider routing `create_agent`
  through the `confirm()` hook like ask-gated commands, and gating which
  tools a created agent may request.
- **Persistence.** agents/ is committed source. Runtime-created agents would
  appear as new code to review after the fact; decide whether creation needs
  an audit trail or a separate runtime-only dir (a `runtime/agents` mirror
  that `loadRegistry` also scans, never written by hand).
- **Prompt hygiene.** LLM-authored system prompts for LLM sub-agents need the
  same no-secrets, no-bypass discipline as the hand-written ones; the model
  must not be able to author an agent whose prompt tells it to evade the
  guardrail deny list.

## Alternative: restart + short-term memory (instead of in-session loading)

**Status: implemented** — `lib/stm.ts` (turn transcript +
`memory/conversations/last.txt` pointer), per-turn append in
`createOrchestrator` when a `convId` is passed, boot-time `--new`/`--resume
<id>` + bare-start-resumes-last, and a `restart` CLI command that re-execs the
process detached with `--resume <convId>` (context rides in the system prompt
via `resumeContext`). Not yet done from the pieces below: distilled summaries
once a transcript outgrows the last-10-turns window, and the agent-creation
path (a new agent still needs authoring + compile before restart — restart
replaces registration, never authoring).

Reject the "same session" constraint: let the orchestrator restart itself and
restore context from a short-term memory store. Boot-time `loadRegistry()`
already re-reads `agents/` fresh and spawned entries read `dist/` at spawn
time, so a restart **is** the reload mechanism — no live registry, no
generic-runner refactor. The whole design collapses into one question: is
conversation context restorable after a restart? Today it is not:

- Sessions on disk hold only delegated `agent-tasks` transcripts; the
  orchestrator's own turns (user Q / agent answers) are never persisted.
- `finalize()` distills only sub-agent tasks into the hasMemory KB — there is
  no short-term/conversation memory layer at all.

### Pieces

1. **Turn transcript** — append `{q, output}` per `ask()` to a rolling
   per-conversation file (a new `memory/conversations/` store).
2. **Resume boot** — `node dist/agent.js --resume <convId>` reads the last K
   turns (or a distilled summary past a budget, memoryWriter-style) and
   prepends them to the resumed turn's input. reactLoop is stateless, so this
   is a read + prepend, no state to rebuild.
3. **Re-exec** — wrapper loop or detached self-spawn inheriting the tty,
   between turns only (no approval pending mid-turn).
4. **Create path is unchanged** — new agents still need authoring + compile
   before restart; restart replaces registration, never authoring. Note a
   mid-session `npm run build` is already safe: delegate() spawns fresh
   processes reading dist at spawn time; the parent's require cache is
   untouched by tsc rewrites.

### Trade-off vs in-session loading

- In-session: ~100 lines (live registry + per-ask roster rebuild + gated
  `create_agent`); no new persistence, no new failure modes.
- Restart + STM: bigger footprint — STM becomes load-bearing for every
  restart/crash/batch re-run (budget + fidelity risk), plus re-exec plumbing.
  Payoff: conversation survival across restarts and crashes, clean per-batch
  processes, and the "same session" constraint disappears everywhere.

**Decision rule:** want continuity as a feature → build STM; restart comes
free. Adding agents is only the excuse — it is never the justification for
STM. Not exclusive: STM would back either design.

## Scope when built (in-session variant)

Generic runner (~60 lines, mostly lifted from the two existing entries),
registry-refresh in `lib/orchestrator.ts` (~30), `create_agent` tool (~40) +
`confirm` gate, agent.json `tools` field validation, smoke-test coverage.
