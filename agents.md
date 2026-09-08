# ReAct agent project — conventions & structure for agents

Read this before touching the codebase. It is the map; code is the territory.
If something related to this doc changes as project evolves update this document.

## What this is

A minimal TypeScript multi-agent framework on the DeepSeek Responses API.
One **orchestrator** ReAct loop answers each user turn; it can run local shell
commands, SSH to remote hosts, and `delegate` tasks to **sub-agents** (separate
directories with `agent.json`). Stateless per turn: sessions are JSON mailboxes
on disk, sub-agents are spawned child node processes.

## Layout

```
agent.ts                 CLI front-end: readline ⇄ createOrchestrator()
system.txt               orchestrator system prompt (has {agents} placeholder)
lib/react.ts             shared ReAct loop over the Responses API (stateless)
lib/orchestrator.ts      turn orchestration, delegate() (mailbox spawn), finalize()
lib/guard.ts             guardrail classification + approval gates (deny/ask)
lib/memory.ts            hub-and-spoke memory store, tools, memoryWriter prompt
conf/config.ts           model/API config (env-driven)
conf/ssh-hosts.ts        SSH hosts; secrets = env var NAMES, never values
conf/guardrails.ts       deny/ask command policy (edit freely)
tools/run-command.ts     run_command tool (local shell)
tools/ssh.ts             run_ssh tool (plink → conf/ssh-hosts.ts)
agents/<SUB-AGENT>/     one dir per sub-agent, e.g. agents/CONFIG-EDITOR/
  agent.json             { name, description, hasMemory }
  system.txt             that agent's system prompt
  agent.ts               entry; compiled to dist/agents/<SUB-AGENT>/agent.js
memory/                  GITIGNORED: sessions/ (mailboxes) + agents/ (KB notes)
docs/feat/               future-feature descriptions (write when deferring)
smoke.js                 `npm run smoke` = build + off-line assertions
```

## Build / run / test

- `npm run build` — `tsc` (all `*.ts` incl. sub-agent dirs → `dist/`)
- `node dist/agent.js` — CLI. Requires `DEEPSEEK_API_KEY`.
- `npm run smoke` — build + off-line checks (no network). Extend it when you
  add non-trivial logic; it caught a real bug already.
- Model knobs: `DEEPSEEK_MODEL`, `DEEPSEEK_REASONING_EFFORT`, orchestrator
  overrides in `conf/config.ts`.

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
- **Sub-agent contract**: orchestrator spawns `node dist/agents/<DIR>/agent.js
  <taskDir>` where `<taskDir>` = `memory/sessions/<sid>/agent-tasks/<tid>/`.
  Child reads `task.json` ({ id, from, to, task }), runs its own reactLoop,
  writes `result.json` ({ id, from, ok, output, log }), exits 0/1. Traces are
  piped to the user as raw stdout — don't print secrets.
- **Registry**: any dir under `agents/` with `agent.json` is a sub-agent.
  Fields:
  `name` (delegate handle), `description` (shown to the orchestrator model),
  `hasMemory: true` to opt into memory. A sub-agent assembles its OWN toolset
  in its agent.ts (shared builders from lib/ and tools/).

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
  is READ, then deleted — order matters).
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

## Hosts & secrets

- Local machine = Windows (cmd), managed hosts = Linux (sh). The boundary is
  pinned in prompts; never route remote config work through run_command.
- Secrets are env vars named in `conf/ssh-hosts.ts` (`WARSZAWA-SMALL-HOST`,
  `-USER`, `-PASS`). Never put a secret literal in code or memory.

## House rules

- Reuse before writing: `lib/`, `tools/`, `conf/` already cover ssh, guards,
  memory, loops. Look before you build.
- Deliberate shortcuts carry a `ponytail:` comment naming the ceiling/upgrade.
- Deferrals and scale-ups go to `docs/feat/` as future-feature notes.
- Keep the smoke test green; extend it for non-trivial logic.
