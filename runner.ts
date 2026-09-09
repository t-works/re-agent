// Generic data-agent entry: one compiled runner serving every agent that has
// an agent.json with a `tools` list and no custom agent.ts — i.e. anything
// created at runtime by create_agent (runtime/agents/) plus hand-authored data
// agents. Spawned by the orchestrator as `node dist/runner.js <agentSrcDir>
// <taskDir>`; everything it needs comes from agent.json + system.txt (both
// data), so a new agent is authoring, never a per-agent build. Custom per-agent
// code stays possible by writing an agent.ts instead — delegate() spawns that
// (compiled) when present.
import { join } from 'path';
import { readFileSync } from 'fs';
import cfg from './conf/config';
import { reactLoop, printLoopEvent } from './lib/react';
import { makeMailboxAsker } from './lib/guard';
import { memoryHubSection } from './lib/memory';
import { readTask, writeResult } from './lib/task';
import { buildAgentTools } from './tools/pool';

if (!cfg.apiKey) { console.error('Set DEEPSEEK_API_KEY first.'); process.exit(1); }

async function main() {
  const agentSrcDir = process.argv[2];
  const taskDir = process.argv[3];
  if (!agentSrcDir || !taskDir) {
    console.error('Usage: node runner.js <agentSrcDir (agent.json + system.txt)> <taskDir>');
    process.exit(1);
  }
  const task = readTask(taskDir);
  const meta = JSON.parse(readFileSync(join(agentSrcDir, 'agent.json'), 'utf8')) as {
    name?: string;
    description?: string;
    tools?: string[];
    hasMemory?: boolean;
  };
  const name = meta.name ?? 'agent';
  const hasMemory = meta.hasMemory === true;
  // Same wiring as the hand-written entries: command tools guarded + approval
  // through the mailbox; model/reasoningEffort ride task.json from agent.json.
  const tools = buildAgentTools({
    name,
    tools: meta.tools ?? [],
    workspace: task.workspace,
    hasMemory,
    ask: makeMailboxAsker(taskDir),
  });
  const systemPrompt =
    readFileSync(join(agentSrcDir, 'system.txt'), 'utf8') + (hasMemory ? memoryHubSection(name) : '');

  const result = await reactLoop({
    systemPrompt,
    task: task.task,
    tools,
    onEvent: printLoopEvent,
    model: task.model,
    reasoningEffort: task.reasoningEffort,
  });
  writeResult(taskDir, { id: task.id, from: name, ok: result.ok, output: result.output, log: result.log });
  process.exit(result.ok ? 0 : 1);
}

main();
