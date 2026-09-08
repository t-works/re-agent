# Future: structured config-apply for config-editor

Today config-editor applies remote changes by prompt discipline: the system
prompt prescribes backup → temp file → validate → atomic mv → reload → verify,
with every state-changing command paused for human approval by the guardrail
policy (`conf/guardrails.ts`). That works because the model follows the
procedure — it does not *enforce* it.

## 1. Structured apply tool
**Future:** a dedicated `apply_config` tool taking `{host, file, newContent,
validateCommand?}` that performs the whole dance itself — timestamped backup,
temp write, runs the validator, atomic rename, then reports — instead of
leaving each step to free-form shell. One approval per apply, not per step.
Per-service validators (`nginx -t`, `systemd-analyze verify`, …) become a
small editable table, genericized once a second service type appears.

## 2. Plan / apply / verify phases
**Future:** config-editor proposes a plan (diff of what changes and why),
the user approves the plan, the agent applies, then verifies and reports —
approval happens once against the *intent*, not per shell command. Requires a
plan-review roundtrip event in the front-end (the mailbox approval channel
already exists).

## 3. Approval history and resumability
**Future:** keep the ask/answer mailbox files per session as an auditable
approval log (today they are deleted after use and only echoed to the
terminal); let a timed-out or interrupted ask be re-opened rather than
re-denied on the next run.

## 4. Host parity
**Now:** local is Windows (cmd), managed hosts are Linux (sh) — the boundary is
pinned in the system prompt. Future managed hosts behind other transports
(docker exec, jump hosts) should reuse the same guardrail policy; the policy is
already tool-agnostic and shared.
