# Future: agent teams — async fan-out, peer messaging, multi-turn tasks

Runtime agent creation is built (see dynamic-agents.md — now a status note).
These are the deliberate deferrals from that work, in the order they pay off.
Nothing here is needed for the current flow (orchestrator plans → creates →
delegates sequentially → supervises on results → tests → reports).

## 1. Async fan-out delegation (cheapest, when tasks get parallel branches)

`delegate()` awaits one child's result.json. Parallel work = spawn several
children and collect later:

- A `delegate_all`-style tool that spawns N agents and returns after all mailboxes
  resolve, or a fire-N + poll-result pair. The machinery is already there:
  delegate is a thin wrapper over task.json/result.json polling; ask.json
  approval relay is per-taskDir and already concurrent-safe.
- The orchestrator's context still sees every result (fan-in is the star
  topology's cost) — pair with workspace artifacts so results are paths, not
  payloads.

## 2. Multi-turn task state (when one task outgrows one turn)

One big task = one big ask() = the orchestrator's stateless history grows with
every tool observation; maxIterations caps the turn. When a real task hits the
wall:

- Split the flow into phases across ask()s with a task-state file
  (plan.json, delegation results, test reports) under
  memory/sessions/<sid>/ or memory/tasks/<tid>/. STM already gives crash
  continuity at conversation granularity; task-state files would give it at
  phase granularity.

## 3. Peer messaging between live agents (biggest step, last)

True agent-to-agent chat (A asks B a question mid-task and waits) needs agents
alive at the same time — an async runtime of long-lived processes, each
holding an API conversation open across polls, plus liveness/timeouts. The
primitive exists: `makeMailboxAsker` is exactly an inbox (publish ask.json,
poll for answer.json); a shared board per agent team is the same shape with
multiple writers. Only worth it for iterative multi-agent coordination
(negotiation, cross-review); for pipelines, workspace artifacts already cover
handoffs without any runtime change.

## 4. Created-agent lifecycle

runtime/agents/ is append-only today; stale specialists accumulate in the
roster and cost prompt tokens every turn. Options when it bites: a
remove_agent tool (confirm-gated, deletes the dir), per-task agent namespaces
cleared between tasks, or a boot sweep for agents older than N days.
