// vision sub-agent entry point. Spawned by the orchestrator with the mailbox dir
// as argv[2] (same contract as CONFIG-EDITOR): read task.json, run a ReAct loop
// whose view_image tool feeds the model real image content, write result.json.
// Model comes from agent.json via task.json (reactLoop falls back to cfg.model
// when absent) — nothing is hardcoded in the entry.
import { basename, join } from 'path';
import { readFileSync } from 'fs';
import cfg from '../../conf/config';
import { reactLoop, printLoopEvent } from '../../lib/react';
import { readTask, writeResult } from '../../lib/task';
import { viewImage } from '../../tools/view-image';

if (!cfg.apiKey) { console.error('Set DEEPSEEK_API_KEY first.'); process.exit(1); }

const SRC_ROOT = join(__dirname, '..', '..', '..'); // dist/agents/VISION -> project root
const MY_DIR = join(SRC_ROOT, 'agents', basename(__dirname)); // source dir of this agent

async function main() {
  const taskDir = process.argv[2];
  if (!taskDir) { console.error('Usage: node agent.js <taskDir containing task.json>'); process.exit(1); }
  const task = readTask(taskDir);
  const meta = JSON.parse(readFileSync(join(MY_DIR, 'agent.json'), 'utf8')) as { name: string };

  const systemPrompt = readFileSync(join(MY_DIR, 'system.txt'), 'utf8');

  const result = await reactLoop({
    systemPrompt,
    task: task.task,
    tools: [viewImage],
    onEvent: printLoopEvent,
    model: task.model,
    reasoningEffort: task.reasoningEffort,
  });
  writeResult(taskDir, { id: task.id, from: meta.name, ok: result.ok, output: result.output, log: result.log });
  process.exit(result.ok ? 0 : 1);
}

main();
