// Orchestrator: CLI front-end that answers questions with local tools or delegates
// to sub-agents (any root subdir with an agent.json) via text-file mailboxes.
// Memory layout:
//   memory/sessions/session-list.json              [{ session-uuid, datetime }]
//   memory/sessions/<session-uuid>/task-list.json  [{ task-uuid, datetime, agent, sequence, status }]
//   memory/sessions/<session-uuid>/agent-tasks/<task-uuid>/{task,result}.json
// Run: npm run build && node dist/agent.js
import { spawn } from 'child_process';
import { randomUUID } from 'crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'fs';
import { join, relative } from 'path';
import { createInterface } from 'readline';
import cfg from './config';
import { reactLoop, runCommand } from './lib/react';

if (!cfg.apiKey) { console.error('Set DEEPSEEK_API_KEY first.'); process.exit(1); }

const SRC_ROOT = join(__dirname, '..'); // compiled (dist) -> project root
const SESSIONS_ROOT = join(SRC_ROOT, 'memory', 'sessions');

type AgentDef = { name: string; description: string; dir: string };
type SessionEntry = { 'session-uuid': string; datetime: string };
type TaskEntry = {
  'task-uuid': string;
  datetime: string;
  agent: string;
  sequence: number;
  status: 'in progress' | 'success' | 'error';
};

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

function readJson<T>(file: string, fallback: T): T {
  try { return JSON.parse(readFileSync(file, 'utf8')) as T; } catch { return fallback; }
}

function appendEntry(file: string, entry: SessionEntry | TaskEntry) {
  const list = readJson<(SessionEntry | TaskEntry)[]>(file, []);
  list.push(entry);
  writeFileSync(file, JSON.stringify(list, null, 2));
}

function setTaskStatus(sessionDir: string, taskUuid: string, status: TaskEntry['status']) {
  const file = join(sessionDir, 'task-list.json');
  const list = readJson<TaskEntry[]>(file, []);
  const entry = list.find((t) => t['task-uuid'] === taskUuid);
  if (entry) entry.status = status;
  writeFileSync(file, JSON.stringify(list, null, 2));
}

// delegate <name> <task>: hand a task to a sub-agent through the session mailbox.
async function delegate(input: string, sessionDir: string): Promise<{ ok: boolean; output: string }> {
  const m = input.match(/^(\S+)\s+([\s\S]*)$/);
  if (!m) return { ok: false, output: 'Usage: delegate <agent name> <task>' };
  const agent = agents.find((a) => a.name === m[1]);
  if (!agent) return { ok: false, output: `Unknown agent: ${m[1]}. Known: ${agents.map((a) => a.name).join(', ')}` };

  const tid = randomUUID();
  const taskDir = join(sessionDir, 'agent-tasks', tid);
  mkdirSync(taskDir, { recursive: true });
  writeFileSync(
    join(taskDir, 'task.json'),
    JSON.stringify({ id: tid, from: 'orchestrator', to: agent.name, task: m[2].trim() }, null, 2)
  );

  const taskListFile = join(sessionDir, 'task-list.json');
  const sequence = readJson<TaskEntry[]>(taskListFile, []).length;
  appendEntry(taskListFile, {
    'task-uuid': tid,
    datetime: new Date().toISOString(),
    agent: agent.name,
    sequence,
    status: 'in progress',
  });
  console.log(`\n>>> delegating to ${agent.name} (#${sequence}, mailbox: ${relative(SRC_ROOT, taskDir)}) <<<`);

  const agentJs = join(__dirname, agent.dir, 'agent.js');
  await new Promise<void>((resolve) => {
    const child = spawn(process.execPath, [agentJs, taskDir], { stdio: ['ignore', 'inherit', 'inherit'] });
    child.on('error', () => resolve());
    child.on('close', () => resolve());
  });

  try {
    const result = JSON.parse(readFileSync(join(taskDir, 'result.json'), 'utf8')) as { ok: boolean; output: string };
    setTaskStatus(sessionDir, tid, result.ok ? 'success' : 'error');
    return { ok: result.ok, output: `[${agent.name}] ${result.output}` };
  } catch {
    setTaskStatus(sessionDir, tid, 'error');
    return { ok: false, output: `${agent.name} agent crashed without a result (${relative(SRC_ROOT, taskDir)})` };
  }
}

const rl = createInterface({ input: process.stdin, output: process.stdout });
let closed = false;
rl.on('close', () => { closed = true; });
const prompt = () => rl.question('\nYou: ', async (q) => {
  if (['quit', 'exit', 'q'].includes(q.trim().toLowerCase())) { rl.close(); return; }

  // one chat turn = one session
  const sid = randomUUID();
  const sessionDir = join(SESSIONS_ROOT, sid);
  mkdirSync(join(sessionDir, 'agent-tasks'), { recursive: true });
  appendEntry(join(SESSIONS_ROOT, 'session-list.json'), { 'session-uuid': sid, datetime: new Date().toISOString() });
  writeFileSync(join(sessionDir, 'task-list.json'), JSON.stringify([], null, 2));
  console.log(`\nSession ${sid} (${relative(SRC_ROOT, sessionDir)})`);

  try {
    const result = await reactLoop({
      systemPrompt,
      task: q,
      tools: [runCommand, { name: 'delegate', run: (i) => delegate(i, sessionDir) }],
    });
    console.log('\nAgent: ' + result.output);
  } catch (e) {
    console.error('Error:', (e as Error).message);
  }
  if (!closed) prompt();
});
console.log(`Orchestrator ready. Sub-agents: ${agents.map((a) => a.name).join(', ') || '(none)'}  (q = quit)`);
prompt();
