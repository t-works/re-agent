// CLI front-end: readline ⇄ orchestrator core (lib/orchestrator.ts). No agent
// logic here — swap this file for an HTTP front-end and the core is unchanged.
// Run: npm run build && node dist/agent.js
import { createInterface } from 'readline';
import cfg from './conf/config';
import { createOrchestrator } from './lib/orchestrator';
import type { TurnEvent } from './lib/orchestrator';
import type { ApprovalRequest } from './lib/guard';
import { printLoopEvent } from './lib/react';

if (!cfg.apiKey) { console.error('Set DEEPSEEK_API_KEY first.'); process.exit(1); }

// Render loop events like the traces always looked; side notes are raw text.
const emit = (e: TurnEvent) => (e.kind === 'note' ? process.stdout.write(e.content) : printLoopEvent(e));

// Human approval gate for guardrailed commands (orchestrator tools and, via the
// mailbox relay, the config-editor sub-agent). No readline question is pending
// while a turn runs, so asking on the same interface is safe.
const confirm = (q: ApprovalRequest) =>
  new Promise<boolean>((resolve) => {
    rl.question(`\n? approve [${q.tool}] ${q.command}\n  (${q.reason}) — y/N: `, (a) => resolve(/^y(es)?$/i.test(a.trim())));
  });
const orchestrator = createOrchestrator(emit, confirm);

const rl = createInterface({ input: process.stdin, output: process.stdout });
const sids: string[] = []; // every turn's session id — handed to finalize() for memory consolidation
let closed = false;
rl.on('close', () => { closed = true; });
const prompt = () => rl.question('\nYou: ', async (q) => {
  if (['quit', 'exit', 'q'].includes(q.trim().toLowerCase())) {
    // End of session: run the memoryWriter consolidation over this conversation's sessions.
    const m = await orchestrator.finalize(sids);
    if (m.output && !m.output.startsWith('no memory')) console.log('\n' + m.output);
    rl.close();
    return;
  }
  try {
    const result = await orchestrator.ask(q);
    sids.push(result.sid);
    console.log('\nAgent: ' + result.output);
  } catch (e) {
    console.error('Error:', (e as Error).message);
  }
  if (!closed) prompt();
});
console.log(`Orchestrator ready. Sub-agents: ${orchestrator.agents.map((a) => a.name).join(', ') || '(none)'}  (q = quit)`);
prompt();
