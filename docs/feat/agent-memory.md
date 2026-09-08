# Future: agent memory at scale

The Directory Structure (Hub-and-Spoke Graph) memory store exists today
(`memory/agents/<agent-name>/index.md` hub + `<topic>.md` spokes), written
synthetically at end of session by the memoryWriter pass and read via hub
injection + the `read_spoke` tool. Deliberate v1 simplifications, and the
upgrades for when they bite:

## 1. Context-size ceiling
**Now:** the whole hub + every spoke (≤4 KB each) is fed to the memoryWriter;
the hub alone is injected at agent startup; spokes are pulled one at a time.
**Problem:** spokes multiply → writer prompt grows past budget.
**Future:** budget-aware loading — the writer gets only changed/relevant
spokes; hub pages if it exceeds N lines; spoke-level TTL and staleness
compaction (merge old spokes into an archive, keep a top-level summary).

## 2. Relevance selection
**Now:** the agent decides which spoke to fetch from one-line hub summaries.
Good enough while hubs are small.
**Future:** a memoryReader that takes the incoming task and returns only the
notes it actually bears on (LLM-routed or embedding-similarity ranked), so
hub summaries stop being the bottleneck and agents stop guessing wrong spokes.

## 3. Cross-agent hub / swarm recomposition
**Now:** per-agent dirs isolate concerns (host config vs coding vs research) —
that's the point — but nothing links them.
**Future:** a root-level hub at `memory/agents/index.md` describing each agent's
memory domain; new agents bootstrap by reading it; a swarm can later be
recomposed by pointing readers/writers at renamed dirs without touching note
content.

## 4. Memory as first-class agents
**Now:** memoryReader/memoryWriter are shared lib/tools inside the orchestrator
process (one distillation LLM call per hasMemory agent at finalize).
**Future:** promote them to registered sub-agents so the swarm can run
multiple writers concurrently, add a reviewer gate on writes (diff + approve
before a note lands), and let any agent *query* memory mid-session instead of
only at startup.

## 5. Durability
**Now:** writes happen at CLI quit (`finalize`); Ctrl-C skips them (accepted —
operator's problem).
**Future:** incremental, idempotent checkpoints — write deltas as sessions
complete, consolidate at session end — so a crash loses at most one turn.
