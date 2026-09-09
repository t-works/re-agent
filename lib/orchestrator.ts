// Orchestrator core: answers one question by running a ReAct loop with local
// tools, delegating to sub-agents (dirs with agent.json) via text-file mailboxes.
// Transport-free — no stdin/stdout/readline here. CLI (agent.ts) and a future
// API front-end both call createOrchestrator().ask().
// Memory layout:
//   memory/sessions/session-list.json              [{ session-uuid }]
//   memory/sessions/<session-uuid>/agent-tasks/<task-uuid>/{task,result}.json
//   memory/conversations/<convId>/transcript.jsonl short-term Q/A log (lib/stm.ts)
import { spawn } from 'child_process';
import { randomUUID } from 'crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs';
import { join, relative } from 'path';
import { reactLoop } from './react';
import type { LoopEvent, Tool } from './react';
import { runCommand } from '../tools/run-command';
import { makeRunSshTool } from '../tools/ssh';
import { wrapGuarded, type ApprovalRequest } from './guard';
import { loadMemoryContext, MEMORY_WRITER_SYSTEM, writeMemoryTools } from './memory';
import { appendTurn } from './stm';
import cfg from '../conf/config';
import policy from '../conf/guardrails';

const SRC_ROOT = join(__dirname, '..', '..'); // dist/lib -> project root
const AGENTS_ROOT = join(SRC_ROOT, 'agents'); // every sub-agent lives in agents/<name>/
const SESSIONS_ROOT = join(SRC_ROOT, 'memory', 'sessions');

export type AgentDef = { name: string; description: string; dir: string; hasMemory: boolean; model?: string; reasoningEffort?: string };
type SessionEntry = { 'session-uuid': string };

// Loop events plus pre-formatted side notes (session banner, sub-agent trace).
export type TurnEvent = LoopEvent | { kind: 'note'; content: string };
export type TurnResult = { ok: boolean; output: string; log: string[]; sid: string };

export type Orchestrator = {
  agents: AgentDef[];
  ask(question: string): Promise<TurnResult>;
  /** End-of-session memory consolidation over the given session ids (all sessions if omitted). */
  finalize(sids?: string[]): Promise<TurnResult>;
};

/** Optional short-term-memory wiring: convId makes ask() append every turn to
 * that conversation's transcript (lib/stm.ts); resumeContext — restored from a
 * previous run's transcript by the front-end — rides in the system prompt so a
 * restarted process keeps conversational context. Both are boot-time options; a
 * bare createOrchestrator() stays STM-free (API front-ends opt in per run). */
export type OrchestratorOpts = { convId?: string; resumeContext?: string };

/**
 * Build an orchestrator. emit receives every loop/note event; confirm lets a
 * front-end answer approval requests (ask-gated commands) interactively — a
 * transport-free hook, the CLI implements it with readline, an API later with
 * an HTTP round-trip. Without confirm, ask-gated commands are auto-denied.
 */
export function createOrchestrator(
  emit?: (e: TurnEvent) => void,
  confirm?: (q: ApprovalRequest) => Promise<boolean>,
  opts: OrchestratorOpts = {}
): Orchestrator {
  const agents = loadRegistry();
  const roster = agents.map((a) => `- ${a.name}: ${a.description}`).join('\n');
  const base = readFileSync(join(SRC_ROOT, 'system.txt'), 'utf8').replace('{agents}', roster || '- (none)');
  const systemPrompt = opts.resumeContext ? base + '\n\n' + opts.resumeContext : base;

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
      JSON.stringify(
        { id: tid, from: 'orchestrator', to: agent.name, task: task.trim(), ...(agent.model && { model: agent.model }), ...(agent.reasoningEffort && { reasoningEffort: agent.reasoningEffort }) },
        null,
        2
      )
    );

    emit?.({ kind: 'note', content: `\n>>> delegating to ${agent.name} (mailbox: ${relative(SRC_ROOT, taskDir)}) <<<\n` });

    const agentJs = join(__dirname, '..', agent.dir, 'agent.js');
    await new Promise<void>((resolve) => {
      // Pipe the sub-agent's trace back through emit (instead of stdio inherit) so an
      // API front-end receives it as events rather than writing to server stdout.
      const child = spawn(process.execPath, [agentJs, taskDir]);
      child.stdout.on('data', (d) => emit?.({ kind: 'note', content: d.toString() }));
      child.stderr.on('data', (d) => emit?.({ kind: 'note', content: d.toString() }));

      // Human-approval gate: while the sub-agent lives, watch its mailbox for an
      // ask.json (a gated command awaiting approval). Relay it to the front-end's
      // confirm() hook and drop the answer into answer.json; the sub-agent's tool
      // resolves on the next poll and either executes or stands down. No confirm
      // hook = safe auto-deny. Same fixed cadence as the child's own poll.
      let approving = false;
      const iv = setInterval(() => {
        if (approving) return;
        let q: ApprovalRequest | null = null;
        try {
          q = JSON.parse(readFileSync(join(taskDir, 'ask.json'), 'utf8')) as ApprovalRequest;
        } catch {
          return; // absent or still being written
        }
        approving = true;
        rmSync(join(taskDir, 'ask.json'), { force: true });
        void (async () => {
          try {
            const approved = confirm ? await confirm(q as ApprovalRequest) : false;
            writeFileSync(join(taskDir, 'answer.json'), JSON.stringify({ approved, at: new Date().toISOString() }, null, 2));
          } finally {
            approving = false;
          }
        })();
      }, policy.pollIntervalMs);
      child.on('error', () => { clearInterval(iv); resolve(); });
      child.on('close', () => {
        clearInterval(iv);
        rmSync(join(taskDir, 'ask.json'), { force: true }); // no stale asks/answers for the next delegate
        rmSync(join(taskDir, 'answer.json'), { force: true });
        resolve();
      });
    });

    try {
      const result = JSON.parse(readFileSync(join(taskDir, 'result.json'), 'utf8')) as { ok: boolean; output: string };
      return { ok: result.ok, output: `[${agent.name}] ${result.output}` };
    } catch {
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
      const sessions = readJson<SessionEntry[]>(join(SESSIONS_ROOT, 'session-list.json'), []);
      sessions.push({ 'session-uuid': sid });
      writeFileSync(join(SESSIONS_ROOT, 'session-list.json'), JSON.stringify(sessions, null, 2));
      emit?.({ kind: 'note', content: `\nSession ${sid} (${relative(SRC_ROOT, sessionDir)})\n` });

      const delegateTool: Tool = {
        name: 'delegate',
        description: agents.length
          ? `Hand a task to a specialist sub-agent and wait for its report. Agents:\n${roster}`
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
      // One guardrail policy for both command tools — picking the other tool is not a
      // way around it. Ask verdicts go to the human (auto-deny when no hook is wired).
      const ask = async (q: ApprovalRequest) => (confirm ? confirm(q) : false);
      const localRun = wrapGuarded(runCommand, ask);
      const tools: Tool[] = [localRun, ...(runSsh ? [wrapGuarded(runSsh, ask)] : []), delegateTool];

      const result = await reactLoop({
        systemPrompt,
        task: question,
        tools,
        onEvent: (e) => emit?.(e),
        model: cfg.orchestratorModel,
        reasoningEffort: cfg.orchestratorReasoningEffort,
      });
      // Short-term memory: log this turn so a restarted process can restore the
      // conversation. Best-effort — a failed write must never fail the turn.
      if (opts.convId) {
        try {
          appendTurn(opts.convId, { sid, q: question, output: result.output });
        } catch { /* ignore */ }
      }
      return { ...result, sid };
    },

    /**
     * End-of-session memory consolidation: for every hasMemory agent that did work
     * in the given sessions, run one memoryWriter distillation pass (a model-only
     * reactLoop with write_spoke/write_index tools) over the task/result transcripts.
     * Synthetic by design — durable facts only, never raw per-delegate noise.
     */
    async finalize(sids?: string[]): Promise<TurnResult> {
      const writers = agents.filter((a) => a.hasMemory);
      if (!writers.length) return { ok: true, output: 'no hasMemory agents registered', log: [], sid: '' };
      const sessions = sids ?? readJson<SessionEntry[]>(join(SESSIONS_ROOT, 'session-list.json'), []).map((s) => s['session-uuid']);
      const perAgent = collectTranscripts(sessions);

      const notes: string[] = [];
      for (const w of writers) {
        const transcripts = perAgent.get(w.name);
        if (!transcripts?.length) continue;
        const { hub, spokes } = loadMemoryContext(w.name);
        const context =
          `Current hub (index.md):\n${hub ?? '(none yet)'}\n\nCurrent spokes:\n` +
          (spokes.length ? spokes.map((s) => `--- ${s.file} ---\n${s.content}`).join('\n\n') : '(none)');
        const result = await reactLoop({
          systemPrompt: MEMORY_WRITER_SYSTEM,
          task: `Consolidate memory for agent "${w.name}".\n\n${context}\n\nSessions to distill into durable memory:\n\n${transcripts.join('\n\n')}`,
          tools: writeMemoryTools(w.name),
        });
        notes.push(`memoryWriter(${w.name}): ${result.ok ? result.output.slice(0, 300) : 'failed: ' + result.output.slice(0, 200)}`);
      }
      return { ok: true, output: notes.length ? notes.join('\n') : 'no memory-worthy activity in these sessions', log: [], sid: '' };
    },
  };
}

/** Scan agents/ for dirs containing agent.json, returning one AgentDef per sub-agent. */
function loadRegistry(): AgentDef[] {
  if (!existsSync(AGENTS_ROOT)) return [];
  return readdirSync(AGENTS_ROOT, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .flatMap((d) => {
      const metaFile = join(AGENTS_ROOT, d.name, 'agent.json');
      if (!existsSync(metaFile)) return [];
      const meta = JSON.parse(readFileSync(metaFile, 'utf8')) as {
        name?: string;
        description?: string;
        hasMemory?: boolean;
        model?: string;        // optional per-agent model override (e.g. deepseek-v4-flash-vision-exp)
        reasoningEffort?: string;
      };
      // dir is project-root-relative (dist mirrors it: dist/agents/<name>/agent.js).
      return [
        {
          name: meta.name ?? d.name,
          description: meta.description ?? '',
          dir: join('agents', d.name),
          hasMemory: meta.hasMemory === true,
          ...(meta.model && { model: meta.model }),
          ...(meta.reasoningEffort && { reasoningEffort: meta.reasoningEffort }),
        },
      ];
    });
}

/** Read and parse a JSON file, returning fallback if missing or corrupt. */
function readJson<T>(file: string, fallback: T): T {
  try { return JSON.parse(readFileSync(file, 'utf8')) as T; } catch { return fallback; }
}

/**
 * Fold each session's agent-task transcripts into a map keyed by the receiving
 * agent's name (as written in task.json). Missing/corrupt entries are skipped.
 */
function collectTranscripts(sids: string[]): Map<string, string[]> {
  const perAgent = new Map<string, string[]>();
  for (const sid of sids) {
    const tasksDir = join(SESSIONS_ROOT, sid, 'agent-tasks');
    if (!existsSync(tasksDir)) continue;
    for (const tid of readdirSync(tasksDir)) {
      try {
        const t = JSON.parse(readFileSync(join(tasksDir, tid, 'task.json'), 'utf8')) as { to?: string; task?: string };
        if (!t.to || !t.task) continue;
        const r = JSON.parse(readFileSync(join(tasksDir, tid, 'result.json'), 'utf8')) as { ok?: boolean; output?: string };
        const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n) + `… (${s.length} chars total)` : s);
        const xs = perAgent.get(t.to) ?? [];
        xs.push(`--- session ${sid.slice(0, 8)} ---\nTASK: ${clip(t.task, 1500)}\nRESULT (ok=${r.ok ?? false}): ${clip(r.output ?? '(empty)', 1500)}`);
        perAgent.set(t.to, xs);
      } catch { /* missing/corrupt task or result — skip */ }
    }
  }
  return perAgent;
}


