// Command guardrails + human approval gate shared by run_command and run_ssh
// (a command can't dodge the policy by picking the "other" tool). Three verdicts:
//   deny  — matched a deny rule: auto-blocked, never runs, never prompts.
//   allow — no rule matched: runs immediately (local work stays unrestricted).
//   ask   — matched an ask rule: pauses for human approval before executing.
// Where the approval comes from is injected, so the same wrapper works in both
// agent shapes: the orchestrator's in-process tools ask via a confirm callback;
// a spawned sub-agent asks through the file mailbox (ask.json / answer.json) that
// the orchestrator's delegate() polls and turns into the same human callback.
import { existsSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import type { Tool } from './react';
import policy from '../conf/guardrails';

export type ApprovalRequest = { tool: string; command: string; reason: string };

/** First matching rule decides; deny and ask rules are ordered in conf/guardrails.ts. */
export function classifyCommand(command: string, toolName: string): 'deny' | 'allow' | ApprovalRequest {
  for (const r of policy.rules) {
    if (r.tool && r.tool !== toolName) continue;
    if (r.pattern.test(command))
      return r.action === 'deny' ? 'deny' : { tool: toolName, command, reason: r.reason };
  }
  return 'allow';
}

/**
 * Wrap a command tool so every run passes through the policy. ask(q) is invoked
 * for 'ask' verdicts and must resolve true to let the command execute.
 */
export function wrapGuarded(tool: Tool, ask: (q: ApprovalRequest) => Promise<boolean>): Tool {
  return {
    ...tool,
    run: async (args) => {
      const command = String(args.command ?? '').trim();
      const verdict = command ? classifyCommand(command, tool.name) : 'allow';
      if (verdict === 'deny') return { ok: false, output: `DENIED by guardrail: ${command} (destructive command policy)` };
      if (verdict !== 'allow' && !(await ask(verdict)))
        return { ok: false, output: `DENIED by user approval: ${verdict.reason}` };
      return tool.run(args);
    },
  };
}

/**
 * Sub-agent side of the approval roundtrip: publish ask.json into the mailbox
 * dir and poll for answer.json until a human (via the orchestrator) replies.
 * Missing/partial ask.json is skipped (the orchestrator polls too, same files).
 */
export function makeMailboxAsker(taskDir: string, overrides?: { pollIntervalMs?: number; approveTimeoutMs?: number }) {
  const poll = overrides?.pollIntervalMs ?? policy.pollIntervalMs;
  const timeout = overrides?.approveTimeoutMs ?? policy.approveTimeoutMs;
  return async (q: ApprovalRequest): Promise<boolean> => {
    // Stale answers from a previous/crashed ask must never auto-approve this one.
    rmSync(join(taskDir, 'answer.json'), { force: true });
    writeFileSync(join(taskDir, 'ask.json'), JSON.stringify(q, null, 2));
    return new Promise((resolve) => {
      const start = Date.now();
      const iv = setInterval(() => {
        const answerFile = join(taskDir, 'answer.json');
        if (existsSync(answerFile)) {
          clearInterval(iv);
          let approved = false;
          try {
            approved = !!((JSON.parse(readFileSync(answerFile, 'utf8')) as { approved?: boolean }).approved);
          } catch {
            approved = false; // unreadable answer — deny is the safe default
          }
          rmSync(join(taskDir, 'ask.json'), { force: true });
          rmSync(answerFile, { force: true });
          resolve(approved);
        } else if (Date.now() - start >= timeout) {
          clearInterval(iv);
          rmSync(join(taskDir, 'ask.json'), { force: true });
          resolve(false);
        }
      }, poll);
    });
  };
}
