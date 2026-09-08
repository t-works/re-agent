// config-editor sub-agent entry point. Spawned by the orchestrator with the
// mailbox dir as argv[2] (same contract the old SSH-AGENT used): read task.json,
// run a ReAct loop with the config toolset, write result.json.
// Guardrails + human approval gate apply to run_command AND run_ssh through
// lib/guard.ts (deny = hard block, ask = mailbox roundtrip the orchestrator
// relays to the user). Memory hub is injected into the system prompt; spokes
// are read on demand with read_spoke (never written here — the end-of-session
// memoryWriter owns the knowledge base).
import { basename, join } from 'path';
import { readFileSync, writeFileSync } from 'fs';
import cfg from '../conf/config';
import { reactLoop, printLoopEvent } from '../lib/react';
import type { Tool } from '../lib/react';
import { makeMailboxAsker, wrapGuarded } from '../lib/guard';
import { readMemoryTools, memoryHubSection } from '../lib/memory';
import { runCommand } from '../tools/run-command';
import { makeRunSshTool } from '../tools/ssh';

if (!cfg.apiKey) { console.error('Set DEEPSEEK_API_KEY first.'); process.exit(1); }

const SRC_ROOT = join(__dirname, '..', '..'); // dist/CONFIG-EDITOR -> project root
const MY_DIR = join(SRC_ROOT, basename(__dirname)); // source dir of this agent

async function main() {
  const taskDir = process.argv[2];
  if (!taskDir) { console.error('Usage: node agent.js <taskDir containing task.json>'); process.exit(1); }
  const task = JSON.parse(readFileSync(join(taskDir, 'task.json'), 'utf8')) as { id: string; task: string };
  const meta = JSON.parse(readFileSync(join(MY_DIR, 'agent.json'), 'utf8')) as { name: string; hasMemory?: boolean };

  const runSsh = makeRunSshTool();
  if (!runSsh) {
    writeFileSync(
      join(taskDir, 'result.json'),
      JSON.stringify({ id: task.id, from: meta.name, ok: false, output: 'No SSH hosts configured (conf/ssh-hosts.ts) — config-editor has nothing to manage.', log: [] }, null, 2)
    );
    process.exit(1);
  }

  // Approval goes through the mailbox: we write ask.json and poll for answer.json;
  // the orchestrator's delegate() relays the ask to the user and drops the answer.
  const ask = makeMailboxAsker(taskDir);
  const tools: Tool[] = [
    wrapGuarded({ ...runCommand }, ask), // local (Windows) — deny-guarded, ask rules are ssh-scoped
    wrapGuarded(runSsh, ask),            // remote (Linux) — full deny + ask policy
    ...(meta.hasMemory ? readMemoryTools(meta.name) : []),
  ];

  const systemPrompt =
    readFileSync(join(MY_DIR, 'system.txt'), 'utf8') + (meta.hasMemory ? memoryHubSection(meta.name) : '');

  const result = await reactLoop({ systemPrompt, task: task.task, tools, onEvent: printLoopEvent });
  writeFileSync(
    join(taskDir, 'result.json'),
    JSON.stringify({ id: task.id, from: meta.name, ok: result.ok, output: result.output, log: result.log }, null, 2)
  );
  process.exit(result.ok ? 0 : 1);
}

main();
