# Status: implemented — runtime agent creation (create_agent + runner + live registry)

This design note is superseded: the "orchestrator creates agents mid-session"
capability is built. What shipped and how (map lives in AGENTS.md):

- **Agents are data when they can be.** `agent.json` gains `tools: string[]`
  (subset of a shared pool: run_command, run_ssh, view_image, read_artifact,
  write_artifact). Data agents have no agent.ts — `delegate()` spawns the one
  generic `runner.ts` (dist/runner.js) with the agent's source dir, which
  derives prompt + toolset from agent.json/system.txt. A new agent = two text
  files, no per-agent compile. Custom code stays an option: presence of a
  compiled `dist/agents/<name>/agent.js` wins over the runner.
- **Live registry.** The roster is re-scanned per turn (system prompt /
  delegate description) and per delegate call, so a same-turn-created agent is
  delegatable immediately. Registry roots: `agents/` (committed) +
  `runtime/agents/` (create_agent output, gitignored); agents/ wins on a name
  collision. This is why `restart`-based continuity and in-session creation
  are complementary, not alternatives: created agents are data on disk, so
  they survive restart (registry re-scan) while lib/stm.ts restores the
  conversation.
- **`create_agent` tool** on the orchestrator: name, description, system
  prompt, tool subset, optional hasMemory/model. Validated against the pool
  and routed through the `confirm()` gate — creating a new command-capable
  principal pauses for the human (no hook = auto-deny). Tool access is
  privilege: pool wrapping means guardrails apply to whatever a model-authored
  prompt tells the agent to do; a prompt can't widen tools (no recursion —
  sub-agents never get create_agent/delegate).
- **Persistence question resolved:** runtime agents live in gitignored
  `runtime/agents/`, inspected after the session; agents/ stays hand-written,
  committed source.

Resolved open questions from the original note: confirm-gating yes; runtime
dir yes; prompt hygiene = advisory because tool-level guardrails are the
enforcement. What was NOT built here (on purpose) — async delegation,
peer messaging, multi-turn task checkpoints, created-agent cleanup — is
tracked in docs/feat/agent-teams.md.
