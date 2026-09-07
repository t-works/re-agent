// CLI front-end: readline ⇄ orchestrator core (lib/orchestrator.ts). No agent
// logic here — swap this file for an HTTP front-end and the core is unchanged.
// Run: npm run build && node dist/agent.js
import { createInterface } from 'readline';
import cfg from './conf/config';
import { createOrchestrator } from './lib/orchestrator';
import type { TurnEvent } from './lib/orchestrator';
import { printLoopEvent } from './lib/react';

if (!cfg.apiKey) { console.error('Set DEEPSEEK_API_KEY first.'); process.exit(1); }

// Render loop events like the traces always looked; side notes are raw text.
const emit = (e: TurnEvent) => (e.kind === 'note' ? process.stdout.write(e.content) : printLoopEvent(e));
const orchestrator = createOrchestrator(emit);

const rl = createInterface({ input: process.stdin, output: process.stdout });
let closed = false;
rl.on('close', () => { closed = true; });
const prompt = () => rl.question('\nYou: ', async (q) => {
  if (['quit', 'exit', 'q'].includes(q.trim().toLowerCase())) { rl.close(); return; }
  try {
    const result = await orchestrator.ask(q);
    console.log('\nAgent: ' + result.output);
  } catch (e) {
    console.error('Error:', (e as Error).message);
  }
  if (!closed) prompt();
});
console.log(`Orchestrator ready. Sub-agents: ${orchestrator.agents.map((a) => a.name).join(', ') || '(none)'}  (q = quit)`);
prompt();
