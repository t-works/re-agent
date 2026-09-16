# ReAct agent project — conventions & structure for agents

Read this before touching the codebase. It is the map; code is the territory.
If something related to this doc changes as project evolves update this document.

## What this is

A minimal TypeScript multi-agent framework on the DeepSeek Responses API.
One **orchestrator** ReAct loop answers each user turn; it can run local shell
commands, SSH to remote hosts, and `delegate` tasks to **sub-agents** (separate
source dirs with `agent.json`), or author new specialist agents at runtime with
`create_agent`. Stateless per turn: sessions are JSON mailboxes on disk,
sub-agents are spawned child node processes.

## Layout

```
agent.ts                 CLI front-end: readline ⇄ createOrchestrator()
runner.ts                generic data-agent entry (agent.json tools list → dist/runner.js)
system.txt               orchestrator system prompt (has {agents} placeholder)
lib/react.ts             shared ReAct loop over the Responses API (stateless)
lib/orchestrator.ts      turn orchestration, delegate() (mailbox spawn), create_agent, finalize()
lib/roots.ts             CODE_ROOT / WORK_ROOT / STATE_ROOT resolution (run from any directory)
lib/guard.ts             guardrail classification + approval gates (deny/ask)
lib/memory.ts            hub-and-spoke memory store, tools, memoryWriter prompt
lib/stm.ts               short-term conversation transcript (restart continuity)
lib/trace.ts             run tracing: per-process JSONL (model/tool/delegate/turn
                         records) + the one-line turn summary; REACT_TRACE=0|full.
                         Design + deferred reader work: docs/feat/tracing-PRD.md
conf/config.ts           model/API config (env-driven)
conf/ssh-hosts.ts        SSH hosts; secrets = env var NAMES, never values
conf/guardrails.ts       deny/ask command policy (edit freely)
tools/run-command.ts     run_command tool (local shell)
tools/ssh.ts             run_ssh tool (plink → conf/ssh-hosts.ts)
tools/view-image.ts      view_image tool (local image → vision model input)
tools/artifact.ts        read/write_artifact tools (workspace file handoffs)
tools/pool.ts            data-agent tool pool: POOL_NAMES + buildAgentTools
tools/github-secrets.ts  set/list/delete_github_secret: GitHub API, libsodium sealed box, approval-gated
agents/<SUB-AGENT>/     one dir per sub-agent, e.g. agents/CONFIG-EDITOR/
  agent.json             { name, description, hasMemory, tools?, model?, reasoningEffort? }
  system.txt             that agent's system prompt
  agent.ts               entry; compiled to dist/agents/<SUB-AGENT>/agent.js
                         (absent + tools list = data agent → runs on runner.ts)
runtime/agents/          create_agent output — writable state, under STATE_ROOT (see Roots)
memory/                  writable state, under STATE_ROOT: sessions/ (mailboxes +
                         per-session workspace/), agents/ (KB notes), conversations/
                         (short-term transcripts, lib/stm.ts)
docs/feat/               future-feature descriptions (write when deferring)
smoke.js                 `npm run smoke` = build + off-line assertions
README.md                npm-facing install/usage blurb
```

## Build / run / test

- `npm run build` — `tsc` (all `*.ts` incl. sub-agent dirs → `dist/`; the
  state dirs `memory/` + `runtime/` are excluded — they are data, not source)
- `node dist/agent.js [--new | --resume <convId>]` — CLI. Requires
  `DEEPSEEK_API_KEY`. A bare start resumes the last conversation; `--new`
  starts fresh. At the prompt, `restart` reboots in place (it drops its own
  compiled modules and boots again) so boot-time state (config, agent registry,
  compiled sub-agents) reloads — conversation context
  rides back in from short-term memory (see below). Run it from the project
  you want it to work on (`cd myproj && node <install>/dist/agent.js`):
  commands run there and state resolves per project (see Roots).
- `npm run smoke` — build + off-line checks (no network). Extend it when you
  add non-trivial logic; it caught a real bug already.
- Model knobs: `DEEPSEEK_MODEL`, `DEEPSEEK_REASONING_EFFORT`, orchestrator
  overrides in `conf/config.ts`.
- **npm module**: `npm pack` (the `prepack` script does a clean build) yields an
  installable tarball; `npm i -g <tarball>` or `npm i <tarball>` gives a
  `react-agent` bin usable from any directory. `files` ships `dist/`,
  `system.txt` and each shipped agent's `agent.json`+`system.txt`. Runtime
  dependencies: one — `libsodium-wrappers` (sealed-box encryption for GitHub
  secrets, `tools/github-secrets.ts`), which is `import()`ed lazily so nothing
  else pays for it. `build` cleans `dist/` first so stale compiles never
  ship. The name `react-agent` is taken on npm — scope/rename before publishing.

## Roots (run from any project)

`lib/roots.ts` replaces the old single `SRC_ROOT` with three roots, so the core
runs from any directory without projects sharing state:

- **`CODE_ROOT`** — the framework install (`dist/lib/..`): read-only assets —
  `system.txt`, shipped `agents/`, `runner.js`. Never written.
- **`WORK_ROOT`** — `process.cwd()` at launch: the project. `run_command` and
  spawned sub-agents inherit it, so commands already run here; the orchestrator
  prompt gets a `Working directory:` line.
- **`STATE_ROOT`** — every writable path (`memory/{sessions,conversations,agents}`,
  `runtime/agents/`). Resolved at boot in order: `$REACT_STATE_DIR` (absolute or
  relative to cwd) → `<WORK_ROOT>/.react` if it already exists (opt-in) →
  `<WORK_ROOT>` if `memory/` already exists (this repo's legacy layout) →
  `~/.react-agent/projects/<basename>-<hash8 of abs path>` (isolated per project).
  `$REACT_HOME` overrides the `~/.react-agent` home. So this repo keeps its
  existing `memory/`, every other project defaults to its own global slot.

The registry merges roots, nearest name wins: `<WORK_ROOT>/agents` →
`<STATE_ROOT>/runtime/agents` → `~/.react-agent/agents` (shared roster, usable
from anywhere) → `CODE_ROOT/agents` (shipped). `AgentDef.dir` is absolute; only
`CODE_ROOT` agents can have a compiled custom entry
(`dist/agents/<name>/agent.js`), everything else runs on `runner.ts`.

`tsconfig.json` excludes `memory/` and `runtime/`: agents write `.ts` files into
session workspaces, and state must never be compiled as source.

## Core conventions

- **Transport-free core.** `lib/*` never reads stdin or writes stdout on its
  own. Front-ends (`agent.ts`, a future API) inject behaviour: `emit` for
  events, `confirm` for approvals. Keep it that way.
- **Tool shape** (`Tool` in lib/react.ts): `{ name, description, parameters
  (JSON Schema), run(args) => Promise<{ ok, output }> }`. Failures return
  `ok:false` with an explanation — never throw (the model recovers from tool
  output, not exceptions).
- **reactLoop** is stateless: full history rides in `input` every request.
  Tools are re-registered per turn.
- **Sub-agent contract**: the orchestrator spawns a compiled entry per agent.
  Custom entries (`agents/<DIR>/agent.ts` → `dist/agents/<DIR>/agent.js`) keep
  a hand-authored toolset; data agents (`agent.json` with a `tools` list, no
  agent.ts — e.g. anything `create_agent` makes) run the shared `runner.ts`
  instead, which derives tools + prompt from agent.json + system.txt. Args:
  custom `node dist/agents/<DIR>/agent.js <taskDir>`, data `node dist/runner.js
  <agentSrcDir> <taskDir>`; `<taskDir>` = `<STATE_ROOT>/memory/sessions/<sid>/agent-tasks/<tid>/`.
  Child reads `task.json` ({ id, from, to, task, workspace?, model?,
  reasoningEffort? }) via `lib/task.ts`, runs its own reactLoop, writes
  `result.json` ({ id, from, ok, output, log }) via lib/task.ts, exits 0/1.
  Traces are piped to the user as raw stdout — don't print secrets.
  `workspace` points at the per-session artifact dir (`memory/sessions/<sid>/workspace/`):
  agents hand each other files there with read_artifact/write_artifact so
  payloads don't round-trip through the orchestrator's context.
- **Registry**: any dir with `agent.json` under `<WORK_ROOT>/agents/` (project),
  `<STATE_ROOT>/runtime/agents/` (created by `create_agent`), `~/.react-agent/agents/`
  (shared), or `CODE_ROOT/agents/` (shipped) is a sub-agent; the nearest root
  wins on a name collision. Fields: `name` (delegate handle),
  `description` (shown to the orchestrator model), `hasMemory: true` to opt
  into memory, optional `model`/`reasoningEffort` (per-agent model override —
  e.g. `agents/VISION/agent.json` declares `deepseek-v4-flash-vision-exp`),
  and `tools: string[]` for data agents (pool in tools/pool.ts: run_command,
  run_ssh, view_image, read_artifact, write_artifact; memory read_spoke comes
  free with hasMemory). Re-scanned per turn and per delegate call — agents
  created mid-session are live without a restart. Fields ride task.json to the
  spawned entry, which passes them to reactLoop; absent fields fall back to
  cfg defaults, so plain agents are untouched.
- **Dynamic agents**: the orchestrator authors new specialists at runtime via
  `create_agent` (writes agent.json + system.txt under `STATE_ROOT/runtime/agents/`,
  after the human approval gate — a new command-capable principal), then delegates
  to them in the same turn; they run on runner.ts (no per-agent build).
  Lifecycle: created agents persist on disk across `restart` (the registry is
  re-scanned at boot); nothing auto-cleans them yet (ponytail: stale rosters
  are the ceiling — add deletion when it bites). Growth ideas (async fan-out,
  peer messaging, multi-turn task state) live in docs/feat/agent-teams.md.

## Guardrails & approvals (security-sensitive — read before changing)

- One policy (`conf/guardrails.ts`), enforced by `lib/guard.ts` on BOTH
  command tools via `wrapGuarded` — choosing the other tool bypasses nothing.
- Verdicts: `deny` (auto-blocked, no prompt) → `ask` (pauses for human) →
  `allow`. Ask rules are `run_ssh`-scoped; the local Windows box stays

  unrestricted. No `/g` regex flags (stateful).
- Approval channel: sub-agent writes `ask.json` into its taskDir and polls for
  `answer.json` (`makeMailboxAsker`); orchestrator `delegate()` polls the same
  dir, relays to the front-end `confirm` hook, writes the answer. No hook =
  safe auto-deny. Stale answers are cleared before each ask (the answer file
  is READ, then deleted — order matters). `create_agent` rides the same gate:
  making a new command-capable principal pauses for approval (no hook =
  auto-deny), because its tool subset is privilege — validated against the
  pool (tools/pool.ts) before anything is written.
- Never instruct a model to bypass a DENIED result; both system.txt files say
  so. User typing in approvals: `rl.question` on the CLI's single readline is
  safe because no question is pending mid-turn.
- Guardrails are a backstop + ask gate, not intent detection. `sed -i` and
  service restarts are where config damage happens — hence the ask list.

## Memory (The Directory Structure, hub-and-spoke)

- Layout: `memory/agents/<agent-name>/index.md` is the HUB (one line per
  spoke), `<topic>.md` files are SPOKES (one topic each). Whole dir is
  gitignored.
- **Read**: hub is injected into a hasMemory agent's system prompt at startup
  (`memoryHubSection`); the agent fetches spokes on demand with `read_spoke`.
- **Write**: agents never write their own KB. `orchestrator.finalize(sids)`
  (called by the CLI on quit) runs one **memoryWriter** distillation pass per
  hasMemory agent over that conversation's task/result transcripts, using
  `write_spoke`/`write_index` (empty content deletes a spoke). Knowledge must
  stay synthetic/durable — no per-delegate clutter, no raw logs.
- Spoke names are path-validated; keep it that way. Growth/scale ideas live in
  `docs/feat/agent-memory.md` — when context budgets bite, read it.

## Short-term memory (conversation continuity across restarts)

Separate from the long-term KB above: a per-conversation Q/A log in
`memory/conversations/<convId>/transcript.jsonl` (one JSON line per turn),
written by `createOrchestrator` when given a `convId` (the CLI always does;
`last.txt` points at the most recent conversation). Each turn appends its line
BEFORE the loop runs (`output: ''`) and `updateLastTurn` patches it with the
final answer — or the error — when the turn ends, so a crash/wedge mid-turn
still leaves the question (marked interrupted) recoverable on restart. On boot
the CLI loads the
last 10 turns (`lib/stm.ts` → `recentContext`, clipped per field) and hands
`resumeContext` to the orchestrator, which appends it to the system prompt —
so a restarted process knows what the conversation covered. Restoration is
deliberately lossy-but-cheap (recent gist, not replay); the full transcript
stays on disk. `restart` finalizes this process's long-term memory, then
reboots in place: it purges its own compiled modules from the require cache,
boots again on the same `convId` (context rides back in from the transcript)
and keeps the terminal and stdin it already has. No second process — a spawned
child on Windows either loses that terminal (detached → not attached to its
console) or dies with it when this process exits (attached), which is exactly
why the old re-exec printed "Restarting" and then appeared to do nothing. Raw + rolling
on purpose: compaction into summaries is future work, and conversations that
outgrow the 10-turn window simply forget their oldest context. For durable
work beyond the gist, the system prompt tells the orchestrator to checkpoint
long builds into a PLAN.md-style file inside the project (see docs/feat/turn-recovery.md
for the crash-recovery ladder and the full mid-turn replay idea).

## Tracing (capture only — the reader is deferred)

Every model call, tool call, delegation and turn is appended as one JSON line:
`memory/sessions/<sid>/trace.jsonl` for the orchestrator turn,
`agent-tasks/<tid>/trace.jsonl` per spawned sub-agent (one writer process per
file, so no locks). Records carry sizes, counts, latencies and `usage` tokens —
never payloads; `REACT_TRACE=full` adds clipped (200-char) args/output snippets.
Each turn prints one summary line through the existing `note` event, and the
child's totals ride back in `result.json`, so the parent's `delegate` record
answers "how long, how many tokens" without reading the child's file. Capture is
best-effort: a failed write never fails a turn. Aggregation/reporting over these
files is Phase 2 (see `docs/feat/tracing-PRD.md`) — do not add a second write
path for a reader.

## Dynamic agents & artifact handoffs

- `create_agent` (orchestrator tool) authors a specialist: unique name,
  description, full system.txt, tool subset from the pool, optional
  hasMemory/model. Writes runtime/agents/<name>/ + system.txt after a confirm
  gate; delegate() can target it the same turn (runner.ts spawn, no build).
  Agent prompt hygiene is advisory — real enforcement is the tool-level
  guardrails the pool wraps in, so a model-authored prompt can't widen access.
- Workspace handoffs: every delegation carries the session workspace path
  (task.json `workspace`); agents with read_artifact/write_artifact exchange
  deliverables there. The orchestrator relays paths, not payloads — its
  context grows with delegations, not with the content flowing between agents.
- Tool subset = privilege, one level deep only: sub-agents never get
  create_agent/delegate, so creation can't recurse.

## Hosts & secrets

- Local machine = Windows running git-bash (bash syntax; falls back to cmd when
  no git-bash is installed), managed hosts = Linux (sh). The boundary is

  pinned in prompts; never route remote config work through run_command.
- Secrets are env vars named in `conf/ssh-hosts.ts` (`WARSZAWA-SMALL-HOST`,
  `-USER`, `-PASS`). Never put a secret literal in code or memory.
- **GitHub secrets** are the one place a secret value must leave the machine, so
  they get their own tool + owner: `tools/github-secrets.ts`
  (`set_github_secret` / `list_github_secrets` / `delete_github_secret`, libsodium
  sealed box over the scope's public key) and the `agents/SECRETS-MANAGER` agent
  that holds it — deliberately absent from `tools/pool.ts`, so neither the
  orchestrator nor a `create_agent` data agent can write secrets; delegate
  instead. Requires `GITHUB_TOKEN` (or `GH_TOKEN`) with secrets write access
  (repo admin; org admin for org scope) — or, when no env token is set, the
  git-ignored PAT file `secrets/github-secrets-pat` that the agent passes to the
  tool as `tokenFile`; only the path travels, never the value. Every write/delete rides the mailbox
  approval gate. Values are sourced inside the tool — `from_env` /
  `from_file` keep the plaintext out of the model's context — and are never
  echoed back (GitHub's API is write-only for values anyway).

## House rules

- Reuse before writing: `lib/`, `tools/`, `conf/` already cover ssh, guards,
  memory, loops. Look before you build.
- Deliberate shortcuts carry a `ponytail:` comment naming the ceiling/upgrade.
- Deferrals and scale-ups go to `docs/feat/` as future-feature notes.
- Keep the smoke test green; extend it for non-trivial logic.
