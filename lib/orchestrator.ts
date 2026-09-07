// Orchestrator core: answers one question by running a ReAct loop with local
// tools, delegating to sub-agents (dirs with agent.json) via text-file mailboxes.
// Transport-free — no stdin/stdout/readline here. CLI (agent.ts) and a future
// API front-end both call createOrchestrator().ask().
// Memory layout:
//   memory/sessions/session-list.json              [{ session-uuid, datetime }]
//   memory/sessions/<session-uuid>/task-list.json  [{ task-uuid, datetime, agent, sequence, status }]
//   memory/sessions/<session-uuid>/agent-tasks/<task-uuid>/{task,result}.json
import { spawn } from 'child_process';
import { randomUUID } from 'crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'fs';
import { join, relative } from 'path';
import { reactLoop } from './react';
import type { LoopEvent, Tool } from './react';
import { runCommand } from '../tools/run-command';
import { makeRunSshTool } from '../tools/ssh';
import cfg from '../conf/config';

const SRC_ROOT = join(__dirname, '..', '..'); // dist/lib -> project root
const SESSIONS_ROOT = join(SRC_ROOT, 'memory', 'sessions');

export type AgentDef = { name: string; description: string; dir: string };
type SessionEntry = { 'session-uuid': string; datetime: string };
type TaskEntry = {
  'task-uuid': string;
  datetime: string;
  agent: string;
  sequence: number;
  status: 'in progress' | 'success' | 'error';
};

// Loop events plus pre-formatted side notes (session banner, sub-agent trace).
export type TurnEvent = LoopEvent | { kind: 'note'; content: string };
export type TurnResult = { ok: boolean; output: string; log: string[]; sid: string };

export type Orchestrator = {
  agents: AgentDef[];
  ask(question: string): Promise<TurnResult>;
};

/** Load the sub-agent registry (dirs with agent.json) and build an orchestrator; emit receives every loop/note event. */
export function createOrchestrator(emit?: (e: TurnEvent) => void): Orchestrator {
  const agents = loadRegistry();
  const systemPrompt = readFileSync(join(SRC_ROOT, 'system.txt'), 'utf8').replace(
    '{agents}',
    agents.length ? agents.map((a) => `- ${a.name}: ${a.description}`).join('\n') : '- (none)'
  );

  /** Hand a task to a sub-agent through the session mailbox (native structured args — no text parsing). */
  async function delegate(name: string, task: string, sessionDir: string): Promise<{ ok: boolean; output: string }> {
    if (!name || !task) return { ok: false, output: 'Usage: delegate with a name and a task' };
    const agent = agents.find((a) => a.name === name);
    if (!agent) return { ok: false, output: `Unknown agent: ${name}. Known: ${agents.map((a) => a.name).join(', ')}` };

    const tid = randomUUID();
    const taskDir = join(sessionDir, 'agent-tasks', tid);
    mkdirSync(taskDir, { recursive: true });
    writeFileSync(
      join(taskDir, 'task.json'),
      JSON.stringify({ id: tid, from: 'orchestrator', to: agent.name, task: task.trim() }, null, 2)
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
    emit?.({ kind: 'note', content: `\n>>> delegating to ${agent.name} (#${sequence}, mailbox: ${relative(SRC_ROOT, taskDir)}) <<<\n` });

    const agentJs = join(__dirname, '..', agent.dir, 'agent.js');
    await new Promise<void>((resolve) => {
      // Pipe the sub-agent's trace back through emit (instead of stdio inherit) so an
      // API front-end receives it as events rather than writing to server stdout.
      const child = spawn(process.execPath, [agentJs, taskDir]);
      child.stdout.on('data', (d) => emit?.({ kind: 'note', content: d.toString() }));
      child.stderr.on('data', (d) => emit?.({ kind: 'note', content: d.toString() }));
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

  return {
    agents,
    /** One chat turn = one session. */
    async ask(question: string): Promise<TurnResult> {
      const sid = randomUUID();
      const sessionDir = join(SESSIONS_ROOT, sid);
      mkdirSync(join(sessionDir, 'agent-tasks'), { recursive: true });
      appendEntry(join(SESSIONS_ROOT, 'session-list.json'), { 'session-uuid': sid, datetime: new Date().toISOString() });
      writeFileSync(join(sessionDir, 'task-list.json'), JSON.stringify([], null, 2));
      emit?.({ kind: 'note', content: `\nSession ${sid} (${relative(SRC_ROOT, sessionDir)})\n` });

      const delegateTool: Tool = {
        name: 'delegate',
        description: agents.length
          ? `Hand a task to a specialist sub-agent and wait for its report. Agents:\n${agents
              .map((a) => `- ${a.name}: ${a.description}`)
              .join('\n')}`
          : '(no sub-agents registered — never use this tool)',
        parameters: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'sub-agent name, exactly as listed in the description' },
            task: { type: 'string', description: 'the task to hand over, in natural language' },
          },
          required: ['name', 'task'],
        },
        run: (args) => delegate(String(args.name ?? ''), String(args.task ?? ''), sessionDir),
      };

      const runSsh = makeRunSshTool();
      const tools: Tool[] = [runCommand, ...(runSsh ? [runSsh] : []), delegateTool];

      const result = await reactLoop({
        systemPrompt,
        task: question,
        tools,
        onEvent: (e) => emit?.(e),
        model: cfg.orchestratorModel,
        reasoningEffort: cfg.orchestratorReasoningEffort,
      });
      return { ...result, sid };
    },
  };
}

/** Scan the project root for dirs containing agent.json, returning one AgentDef per sub-agent. */
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

/** Read and parse a JSON file, returning fallback if missing or corrupt. */
function readJson<T>(file: string, fallback: T): T {
  try { return JSON.parse(readFileSync(file, 'utf8')) as T; } catch { return fallback; }
}

/** Append an entry to a JSON list file, creating the file with [entry] if absent. */
function appendEntry(file: string, entry: SessionEntry | TaskEntry) {
  const list = readJson<(SessionEntry | TaskEntry)[]>(file, []);
  list.push(entry);
  writeFileSync(file, JSON.stringify(list, null, 2));
}

/** Flip one task's status in a session's task-list.json. */
function setTaskStatus(sessionDir: string, taskUuid: string, status: TaskEntry['status']) {
  const file = join(sessionDir, 'task-list.json');
  const list = readJson<TaskEntry[]>(file, []);
  const entry = list.find((t) => t['task-uuid'] === taskUuid);
  if (entry) entry.status = status;
  writeFileSync(file, JSON.stringify(list, null, 2));
}
