// secrets-manager sub-agent entry point. Spawned by the orchestrator with the
// mailbox dir as argv[2] (the config-editor contract): read task.json, run a
// ReAct loop over the GitHub secret tools, write result.json.
// The toolset is hand-authored here instead of taken from tools/pool.ts,
// because setting secrets is a capability only this agent should hold: the
// orchestrator and runtime-created data agents get no secret-writing tool.
// Values are sourced inside the tool (from_env / from_file), so plaintext
// never has to pass through the model; every write and delete goes through the
// mailbox approval gate (ask.json / answer.json) the orchestrator relays to the
// user. run_command is the local shell (ask rules are run_ssh-scoped) and is
// only there for inspecting the working directory — never for writing secrets.
import { basename, join } from 'path';
import { existsSync, readFileSync } from 'fs';
import cfg from '../../conf/config';
import { reactLoop, printLoopEvent } from '../../lib/react';
import type { Tool } from '../../lib/react';
import { makeMailboxAsker, wrapGuarded } from '../../lib/guard';
import { readTask, writeResult } from '../../lib/task';
import { runCommand } from '../../tools/run-command';
import { makeGithubSecretsTools } from '../../tools/github-secrets';

if (!cfg.apiKey) { console.error('Set DEEPSEEK_API_KEY first.'); process.exit(1); }

const SRC_ROOT = join(__dirname, '..', '..', '..'); // dist/agents/SECRETS-MANAGER -> project root
const MY_DIR = join(SRC_ROOT, 'agents', basename(__dirname)); // source dir of this agent
// Fallback PAT: the git-ignored secrets/ dir of this project (the same file a
// shell would read with $(< secrets/github-secrets-pat)). Only the path is
// handed to the tool — the value is read inside it and never passes the model.
const TOKEN_FILE = join(SRC_ROOT, 'secrets', 'github-secrets-pat');

async function main() {
  const taskDir = process.argv[2];
  if (!taskDir) { console.error('Usage: node agent.js <taskDir containing task.json>'); process.exit(1); }
  const task = readTask(taskDir);
  const meta = JSON.parse(readFileSync(join(MY_DIR, 'agent.json'), 'utf8')) as { name: string; hasMemory?: boolean };

  // Approval via the mailbox: we write ask.json and poll answer.json; the
  // orchestrator's delegate() shows the ask to the user and drops the answer.
  const ask = makeMailboxAsker(taskDir);
  const tools: Tool[] = [
    ...makeGithubSecretsTools({ ask, tokenFile: existsSync(TOKEN_FILE) ? TOKEN_FILE : undefined }),
    wrapGuarded({ ...runCommand }, ask),
  ];

  const systemPrompt = readFileSync(join(MY_DIR, 'system.txt'), 'utf8');

  const result = await reactLoop({
    systemPrompt,
    task: task.task,
    tools,
    onEvent: printLoopEvent,
    model: task.model,
    reasoningEffort: task.reasoningEffort,
  });
  writeResult(taskDir, { id: task.id, from: meta.name, ok: result.ok, output: result.output, log: result.log });
  process.exit(result.ok ? 0 : 1);
}

main();
