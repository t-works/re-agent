#!/usr/bin/env node
// CLI front-end: readline ⇄ orchestrator core (lib/orchestrator.ts). No agent
// logic here — swap this file for an HTTP front-end and the core is unchanged.
// Run: npm run build && node dist/agent.js [--new | --resume <convId>]
// Continuity across processes: each turn's Q/A is logged to short-term memory
// (lib/stm.ts, memory/conversations/<convId>/transcript.jsonl). A bare start
// resumes the last conversation; `restart` at the prompt re-execs this process
// (--resume <convId>) so boot-time state — the agent registry, compiled
// sub-agents — reloads while the conversation context rides back in.
import { createInterface } from 'readline';
import { spawn } from 'child_process';
import { randomUUID } from 'crypto';
import cfg from './conf/config';
import { createOrchestrator } from './lib/orchestrator';
import type { TurnEvent } from './lib/orchestrator';
import type { ApprovalRequest } from './lib/guard';
import { printLoopEvent } from './lib/react';
import { STATE_ROOT, WORK_ROOT } from './lib/roots';
import * as stm from './lib/stm';

if (!cfg.apiKey) { console.error('Set DEEPSEEK_API_KEY first.'); process.exit(1); }

/** Conversation boot: --new = fresh, --resume <id> = pick one, bare start =
 * resume the last conversation (continuity by default). */
function resolveConversation(argv: string[]): { convId: string; resumed: boolean; count: number; context: string } {
  let mode: 'last' | 'new' | 'resume' = 'last';
  let resumeId = '';
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--new') mode = 'new';
    else if (a === '--resume') {
      resumeId = argv[++i] ?? '';
      if (!stm.isValidConvId(resumeId)) throw new Error(`bad conversation id for --resume: ${resumeId || '(missing)'}`);
      mode = 'resume';
    } else throw new Error(`unknown argument: ${a} (use --new or --resume <id>)`);
  }
  const pick = (convId: string) => {
    const { block, count } = stm.recentContext(convId);
    return { convId, resumed: true, count, context: block };
  };
  if (mode === 'resume') return pick(resumeId);
  const last = mode === 'last' ? stm.lastConvId() : null;
  if (last) return pick(last);
  return { convId: 'c' + randomUUID().replace(/-/g, '').slice(0, 12), resumed: false, count: 0, context: '' };
}

let boot: ReturnType<typeof resolveConversation>;
try {
  boot = resolveConversation(process.argv);
} catch (e) {
  console.error('Error:', (e as Error).message);
  process.exit(1);
}
const { convId } = boot;
stm.rememberLast(convId); // a bare relaunch keeps returning to this conversation

// Render loop events like the traces always looked; side notes are raw text.
const emit = (e: TurnEvent) => (e.kind === 'note' ? process.stdout.write(e.content) : printLoopEvent(e));

// Human approval gate for guardrailed commands (orchestrator tools and, via the
// mailbox relay, the config-editor sub-agent). No readline question is pending
// while a turn runs, so asking on the same interface is safe.
const confirm = (q: ApprovalRequest) =>
  new Promise<boolean>((resolve) => {
    rl.question(`\n? approve [${q.tool}] ${q.command}\n  (${q.reason}) — y/N: `, (a) => resolve(/^y(es)?$/i.test(a.trim())));
  });

// convId opts the core into short-term memory (every turn is appended to the
// transcript); resumeContext rides in this process's system prompt only.
const orchestrator = createOrchestrator(emit, confirm, { convId, resumeContext: boot.context });

const rl = createInterface({ input: process.stdin, output: process.stdout });
const sids: string[] = []; // every turn's session id — handed to finalize() for memory consolidation
let closed = false;
rl.on('close', () => { closed = true; });

// End of this process: consolidate long-term memory over this process's
// sessions, then exit — or re-exec with --resume so boot-time state (agent
// registry, compiled sub-agents) reloads while the conversation rides back in
// from the short-term transcript. Runs only between turns (no approval pending).
async function shutdown(restarting: boolean) {
  if (closed) return;
  closed = true;
  rl.close();
  const m = await orchestrator.finalize(sids).catch(() => null);
  if (m?.output && !m.output.startsWith('no memory')) console.log('\n' + m.output);
  if (restarting) {
    console.log(`\nRestarting — conversation ${convId} resumes from short-term memory.`);
    // Detached + inherited stdio: the child keeps this terminal after we exit.
    const child = spawn(process.execPath, [process.argv[1], '--resume', convId], { stdio: 'inherit', detached: true });
    child.unref();
  }
  process.exit(0);
}

const prompt = () => rl.question('\nYou: ', async (q) => {
  const cmd = q.trim().toLowerCase();
  if (cmd === 'restart' || ['quit', 'exit', 'q'].includes(cmd)) return shutdown(cmd === 'restart');
  try {
    const result = await orchestrator.ask(q);
    sids.push(result.sid);
    console.log('\nAgent: ' + result.output);
  } catch (e) {
    console.error('Error:', (e as Error).message);
  }
  if (!closed) prompt();
});

console.log(
  `Orchestrator ready. Sub-agents: ${orchestrator.agents.map((a) => a.name).join(', ') || '(none)'}\n` +
  `Working dir: ${WORK_ROOT}\n` +
  `State:       ${STATE_ROOT}\n` +
  `Conversation ${convId} — ${boot.resumed ? `resumed (last ${boot.count} turn${boot.count === 1 ? '' : 's'} in context)` : 'new'}` +
  '  (q = quit, restart = reload process with context)'
);
prompt();
