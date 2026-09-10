# Turn recovery (crash-safe sessions)

Why: a crash/wedge mid-turn previously lost the entire conversation context —
the interrupted turn was never logged, and resume showed "last 0 turns".
Durable file work survived only if it had already been written to disk.

The crash-recovery ladder, cheapest rung first:

1. **Interrupted turns survive (done).** `createOrchestrator` appends the turn's
   question to `transcript.jsonl` BEFORE the loop starts (`output: ''`) and
   `lib/stm.ts:updateLastTurn` patches that same line with the final answer —
   or `ERROR: <message>` — when the turn ends (lib/orchestrator.ts). A crashed
   turn resumes as "(interrupted — this turn did not complete)", question
   intact, so the user can re-answer or the agent can continue.
2. **Durable work on disk (done).** The orchestrator system prompt (system.txt,
   "Durable work (crash safety)") tells it to checkpoint substantial builds
   into a PLAN.md-style progress file in the project, updated as steps
   complete. Files survive crashes; context does not.
3. **Full mid-turn checkpointing + verbatim replay (future).** Re-hydrating the
   raw response history (function_call/reasoning items incl. encrypted CoT
   content) across a restart so a turn continues exactly where it stopped.
   Heavy and fragile — the encrypted reasoning echo may be session-bound, and
   continuation semantics differ from a fresh stateless request. Only worth it
   if rungs 1+2 keep biting (long turns still losing too much on crash).
