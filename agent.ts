// Orchestrator: CLI front-end that answers questions with local tools or delegates
// to sub-agents (any root subdir with an agent.json) via text-file mailboxes.
// Run: npm run build && node dist/agent.js
import { spawn } from 'child_process';
import { randomUUID } from 'crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { createInterface } from 'readline';
import cfg from './config';
import { reactLoop, runCommand } from './lib/react';

if (!cfg.apiKey) { console.error('Set DEEPSEEK_API_KEY first.'); process.exit(1); }

const SRC_ROOT = join(__dirname, '..'); // compiled (dist) -> project root
const WORK_ROOT = join(SRC_ROOT, 'work');

type AgentDef = { name: string; description: string; dir: string };

function loadRegistry(): AgentDef[] {
  return readdirSync(SRC_ROOT, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .flatMap((d) => {
      const metaFile = join(SRC_ROOT, d.name, 'agent.json');
      if (!existsSync(metaFile)) return [];
      const meta = JSON.parse(readFileSync(metaFile, 'utf8')) as { name?: string; description?: string };
      return [{ name: meta.name ?? d.name, description: meta.description ?? '', dir: d.name }];
    });
}

const agents = loadRegistry();
const systemPrompt = readFileSync(join(SRC_ROOT, 'system.txt'), 'utf8').replace(
  '{agents}',
  agents.length ? agents.map((a) => `- ${a.name}: ${a.description}`).join('\n') : '- (none)'
);

// delegate <name> <task>: hand a task to a sub-agent through a work/<id> mailbox.
async function delegate(input: string): Promise<{ ok: boolean; output: string }> {
  const m = input.match(/^(\S+)\s+([\s\S]*)$/);
  if (!m) return { ok: false, output: 'Usage: delegate <agent name> <task>' };
  const agent = agents.find((a) => a.name === m[1]);
  if (!agent) return { ok: false, output: `Unknown agent: ${m[1]}. Known: ${agents.map((a) => a.name).join(', ')}` };

  const id = randomUUID();
  const workDir = join(WORK_ROOT, id);
  mkdirSync(workDir, { recursive: true });
  writeFileSync(
    join(workDir, 'task.json'),
    JSON.stringify({ id, from: 'orchestrator', to: agent.name, task: m[2].trim() }, null, 2)
  );
  console.log(`\n>>> delegating to ${agent.name} (mailbox: work/${id}/) <<<`);

  const agentJs = join(__dirname, agent.dir, 'agent.js');
  await new Promise<void>((resolve) => {
    const child = spawn(process.execPath, [agentJs, workDir], { stdio: ['ignore', 'inherit', 'inherit'] });
    child.on('error', () => resolve());
    child.on('close', () => resolve());
  });

  try {
    const result = JSON.parse(readFileSync(join(workDir, 'result.json'), 'utf8')) as {
      ok: boolean;
      output: string;
    };
    return { ok: result.ok, output: `[${agent.name}] ${result.output}` };
  } catch {
    return { ok: false, output: `${agent.name} agent crashed without a result (see work/${id}/)` };
  }
}

const rl = createInterface({ input: process.stdin, output: process.stdout });
let closed = false;
rl.on('close', () => { closed = true; });
const prompt = () => rl.question('\nYou: ', async (q) => {
  if (['quit', 'exit', 'q'].includes(q.trim().toLowerCase())) { rl.close(); return; }
  try {
    const result = await reactLoop({ systemPrompt, task: q, tools: [runCommand, { name: 'delegate', run: delegate }] });
    console.log('\nAgent: ' + result.output);
  } catch (e) {
    console.error('Error:', (e as Error).message);
  }
  if (!closed) prompt();
});
console.log(`Orchestrator ready. Sub-agents: ${agents.map((a) => a.name).join(', ') || '(none)'}  (q = quit)`);
prompt();
