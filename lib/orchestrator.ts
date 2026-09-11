// Orchestrator core: answers one question by running a ReAct loop with local
// tools, delegating to sub-agents (dirs with agent.json) via text-file mailboxes.
// Transport-free — no stdin/stdout/readline here. CLI (agent.ts) and a future
// API front-end both call createOrchestrator().ask().
// Memory layout (all under STATE_ROOT, see lib/roots.ts):
//   memory/sessions/session-list.json              [{ session-uuid }]
//   memory/sessions/<session-uuid>/agent-tasks/<task-uuid>/{task,result}.json
//   memory/conversations/<convId>/transcript.jsonl short-term Q/A log (lib/stm.ts)
import { spawn } from 'child_process';
import { randomUUID } from 'crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs';
import { isAbsolute, join, relative } from 'path';
import { reactLoop } from './react';
import type { LoopEvent, Tool } from './react';
import { runCommand } from '../tools/run-command';
import { makeRunSshTool } from '../tools/ssh';
import { POOL_NAMES } from '../tools/pool';
import { wrapGuarded, type ApprovalRequest } from './guard';
import { loadMemoryContext, MEMORY_WRITER_SYSTEM, writeMemoryTools } from './memory';
import { appendTurn, updateLastTurn } from './stm';
import cfg from '../conf/config';
import policy from '../conf/guardrails';
import { CODE_ROOT, HOME_ROOT, STATE_ROOT, WORK_ROOT } from './roots';

// Registry roots, nearest wins (see loadRegistry): project-authored agents,
// agents created during this project's sessions, the shared user roster, then
// the shipped ones. Only CODE_ROOT agents can have a compiled custom entry.
const PROJECT_AGENTS_ROOT = join(WORK_ROOT, 'agents');
const AGENTS_ROOT = join(CODE_ROOT, 'agents');
const RUNTIME_AGENTS_ROOT = join(STATE_ROOT, 'runtime', 'agents');
const HOME_AGENTS_ROOT = join(HOME_ROOT, 'agents');
const SESSIONS_ROOT = join(STATE_ROOT, 'memory', 'sessions');

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
  // Boot snapshot (returned to the front-end for its banner). The registry is
  // re-scanned per ask() and per delegate call, so agents created mid-session
  // (create_agent → runtime/agents/) are live without a restart.
  const agents = loadRegistry();

  /** Roster + full orchestrator system prompt, rebuilt from a fresh scan each turn. */
  function buildSystemPrompt(): string {
    const roster = loadRegistry().map((a) => `- ${a.name}: ${a.description}`).join('\n');
    const base = readFileSync(join(CODE_ROOT, 'system.txt'), 'utf8').replace('{agents}', roster || '- (none)');
    const located = `${base}\n\nWorking directory: ${WORK_ROOT} — run_command and delegated agents operate here.`;
    return opts.resumeContext ? located + '\n\n' + opts.resumeContext : located;
  }

  /** Hand a task to a sub-agent through the session mailbox (native structured args — no text parsing). */
  async function delegate(name: string, task: string, sessionDir: string): Promise<{ ok: boolean; output: string }> {
    if (!name || !task) return { ok: false, output: 'Usage: delegate with a name and a task' };
    // Fresh scan: an agent created earlier in this same turn must be delegatable now.
    const agent = loadRegistry().find((a) => a.name === name);
    if (!agent)
      return { ok: false, output: `Unknown agent: ${name}. Known: ${loadRegistry().map((a) => a.name).join(', ')}` };

    const tid = randomUUID();
    const taskDir = join(sessionDir, 'agent-tasks', tid);
    mkdirSync(taskDir, { recursive: true });
    writeFileSync(
      join(taskDir, 'task.json'),
      JSON.stringify(
        {
          id: tid, from: 'orchestrator', to: agent.name, task: task.trim(),
          workspace: join(sessionDir, 'workspace'), // shared artifact dir for this session's agents
          ...(agent.model && { model: agent.model }),
          ...(agent.reasoningEffort && { reasoningEffort: agent.reasoningEffort }),
        },
        null,
        2
      )
    );

    emit?.({ kind: 'note', content: `\n>>> delegating to ${agent.name} (mailbox: ${relative(STATE_ROOT, taskDir)}) <<<\n` });

    // Compiled custom entry wins; data agents (agent.json with a tools list, no
    // agent.ts) run on the shared generic runner — new agents need no per-agent
    // build. Only shipped agents sit under CODE_ROOT and have a dist mirror;
    // project/runtime agents (absolute dir) are data agents on the runner.
    const inCode = relative(CODE_ROOT, agent.dir);
    const agentJs =
      inCode && !inCode.startsWith('..') && !isAbsolute(inCode)
        ? join(CODE_ROOT, 'dist', inCode, 'agent.js')
        : join(agent.dir, 'agent.js');
    const entryArgs = existsSync(agentJs)
      ? [agentJs, taskDir]
      : [join(__dirname, '..', 'runner.js'), agent.dir, taskDir];
    await new Promise<void>((resolve) => {
      // Pipe the sub-agent's trace back through emit (instead of stdio inherit) so an
      // API front-end receives it as events rather than writing to server stdout.
      const child = spawn(process.execPath, entryArgs);
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
      return { ok: false, output: `${agent.name} agent crashed without a result (${relative(STATE_ROOT, taskDir)})` };
    }
  }

  return {
    agents,
    /** One chat turn = one session. */
    async ask(question: string): Promise<TurnResult> {
      const sid = randomUUID();
      const sessionDir = join(SESSIONS_ROOT, sid);
      mkdirSync(join(sessionDir, 'agent-tasks'), { recursive: true });
      mkdirSync(join(sessionDir, 'workspace'), { recursive: true }); // artifact handoff dir for delegated agents
      const sessions = readJson<SessionEntry[]>(join(SESSIONS_ROOT, 'session-list.json'), []);
      sessions.push({ 'session-uuid': sid });
      writeFileSync(join(SESSIONS_ROOT, 'session-list.json'), JSON.stringify(sessions, null, 2));
      emit?.({ kind: 'note', content: `\nSession ${sid} (${relative(STATE_ROOT, sessionDir)})\n` });
      const systemPrompt = buildSystemPrompt(); // fresh roster each turn: created agents appear next turn

      const delegateTool: Tool = {
        name: 'delegate',
        description: loadRegistry().length
          ? `Hand a task to a specialist sub-agent and wait for its report.\nAgents:\n${loadRegistry().map((a) => `- ${a.name}: ${a.description}`).join('\n')}\n\nSession workspace — delegated agents exchange artifacts here via read_artifact/write_artifact. When one step's output feeds the next, have the first agent write it to a file and pass the next agent the path (keep payloads out of your context): ${join(sessionDir, 'workspace')}`
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

      // Meta: author a specialist agent (agent.json + system.txt data) that delegate()
      // spawns on the shared runner — no per-agent build. Creating a new command-capable
      // principal (persisted under runtime/agents/), so it passes the same human gate as
      // ask-gated commands. Tool subset is privilege: validated against the pool below.
      const createAgentTool: Tool = {
        name: 'create_agent',
        description:
          `Create a new specialist sub-agent for this task, delegatable within the same turn. Choose it for a substantial specialist job no existing agent covers (a tailored system prompt + narrow tool subset) — never for one-off trivial steps you can run yourself, and never a duplicate of an existing agent's domain.\n` +
          `- name: unique, lowercase letters/digits/hyphens.\n` +
          `- description: one paragraph of its domain and job (shown in rosters).\n` +
          `- systemPrompt: full operating instructions — identity, domain, job, working rules, boundaries. Model it on the hand-written sub-agents' prompts. State: no secrets in output; a DENIED tool result means the action did not happen — never rephrase or split to bypass it.\n` +
          `- tools: subset of ${POOL_NAMES.join(', ')}. run_command/run_ssh are guardrailed automatically; view_image needs a vision model (set model, e.g. deepseek-v4-flash-vision-exp); read_artifact/write_artifact exchange files in the session workspace.\n` +
          `- hasMemory: true only if it should carry durable notes across sessions.\n` +
          `Creation pauses for the user's approval. Created agents persist under runtime/agents/ and stay usable after a restart.`,
        parameters: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'unique agent name (a-z0-9-), the delegate handle' },
            description: { type: 'string', description: 'one-paragraph domain/job summary (roster text)' },
            systemPrompt: { type: 'string', description: 'the agent\'s full system prompt' },
            tools: { type: 'array', items: { type: 'string' }, description: `subset of: ${POOL_NAMES.join(', ')} (omit for a pure reasoning agent)` },
            hasMemory: { type: 'boolean', description: 'durable notes across sessions (default false)' },
            model: { type: 'string', description: 'model override (only needed for view_image work)' },
          },
          required: ['name', 'description', 'systemPrompt'],
        },
        run: async (args) => {
          const v = validateAgentSpec(args as CreateAgentSpec);
          if (!v.ok) return { ok: false, output: v.error };
          if (loadRegistry().some((a) => a.name === v.validated.json.name))
            return { ok: false, output: `An agent named "${v.validated.json.name}" already exists — reuse it or pick another name.` };
          const dir = join(RUNTIME_AGENTS_ROOT, v.validated.json.name);
          const approved = await ask({
            tool: 'create_agent',
            command: `create agent "${v.validated.json.name}" (tools: ${v.validated.json.tools.join(', ') || 'none'})`,
            reason: 'creates a new sub-agent under runtime/agents/ — inspect after the session',
          });
          if (!approved) return { ok: false, output: 'DENIED by user approval: no agent created' };
          mkdirSync(dir, { recursive: true });
          writeFileSync(join(dir, 'agent.json'), JSON.stringify(v.validated.json, null, 2));
          writeFileSync(join(dir, 'system.txt'), v.validated.systemPrompt.trimEnd() + '\n');
          return {
            ok: true,
            output: `Agent "${v.validated.json.name}" created (${relative(STATE_ROOT, dir)}). Delegate to it now with delegate(name: "${v.validated.json.name}", ...).`,
          };
        },
      };

      const tools: Tool[] = [localRun, ...(runSsh ? [wrapGuarded(runSsh, ask)] : []), delegateTool, createAgentTool];

      // Short-term memory: log the question BEFORE the turn runs, so a crash or
      // wedge mid-turn still leaves the conversation recoverable on restart; the
      // completed turn's output (or the error) then patches that same last line.
      // Best-effort — a failed write must never fail the turn.
      if (opts.convId) {
        try {
          appendTurn(opts.convId, { sid, q: question, output: '' });
        } catch { /* ignore */ }
      }
      let result;
      try {
        result = await reactLoop({
          systemPrompt,
          task: question,
          tools,
          onEvent: (e) => emit?.(e),
          model: cfg.orchestratorModel,
          reasoningEffort: cfg.orchestratorReasoningEffort,
        });
      } catch (e) {
        if (opts.convId) {
          try { updateLastTurn(opts.convId, { output: 'ERROR: ' + (e as Error).message }); } catch { /* ignore */ }
        }
        throw e;
      }
      if (opts.convId) {
        try { updateLastTurn(opts.convId, { output: result.output }); } catch { /* ignore */ }
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
      const writers = loadRegistry().filter((a) => a.hasMemory); // fresh scan: includes runtime-created memory agents
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

/**
 * Scan the registry roots for dirs containing agent.json — project agents
 * (<WORK_ROOT>/agents), this project's session-created agents, the shared user
 * roster (~/.react-agent/agents), then the shipped <CODE_ROOT>/agents. The
 * first occurrence of a name wins (the nearest root is authoritative).
 */
function loadRegistry(): AgentDef[] {
  const entries = [PROJECT_AGENTS_ROOT, RUNTIME_AGENTS_ROOT, HOME_AGENTS_ROOT, AGENTS_ROOT].flatMap(scanRoot);
  const seen = new Set<string>();
  return entries.filter((a) => (seen.has(a.name) ? false : (seen.add(a.name), true)));
}

function scanRoot(root: string): AgentDef[] {
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .flatMap((d) => {
      const metaFile = join(root, d.name, 'agent.json');
      if (!existsSync(metaFile)) return [];
      const meta = JSON.parse(readFileSync(metaFile, 'utf8')) as {
        name?: string;
        description?: string;
        hasMemory?: boolean;
        model?: string; // optional per-agent model override (e.g. deepseek-v4-flash-vision-exp)
        reasoningEffort?: string;
      };
      // dir is absolute: shipped agents under CODE_ROOT have a dist mirror
      // (dist/agents/<name>/agent.js for custom entries); project/runtime agents
      // have no dist copy and run on the shared runner instead.
      return [
        {
          name: meta.name ?? d.name,
          description: meta.description ?? '',
          dir: join(root, d.name),
          hasMemory: meta.hasMemory === true,
          ...(meta.model && { model: meta.model }),
          ...(meta.reasoningEffort && { reasoningEffort: meta.reasoningEffort }),
        },
      ];
    });
}

// ---- create_agent spec validation (pure — smoke-testable offline) ----
export type CreateAgentSpec = {
  name?: unknown;
  description?: unknown;
  systemPrompt?: unknown;
  tools?: unknown;
  hasMemory?: unknown;
  model?: unknown;
};

export type AgentJson = {
  name: string;
  description: string;
  tools: string[];
  hasMemory?: boolean;
  model?: string;
};

export type ValidatedAgentSpec = { json: AgentJson; systemPrompt: string };

/** Format-level checks for create_agent: name charset, tool subset, size caps. */
export function validateAgentSpec(
  spec: CreateAgentSpec
): { ok: true; validated: ValidatedAgentSpec } | { ok: false; error: string } {
  const name = String(spec.name ?? '').trim();
  const description = String(spec.description ?? '').trim();
  const systemPrompt = String(spec.systemPrompt ?? '').trim();
  const tools = Array.isArray(spec.tools) ? spec.tools.map((t) => String(t).trim()).filter(Boolean) : [];
  const hasMemory = spec.hasMemory === true;
  const model = spec.model ? String(spec.model).trim() : '';
  if (!/^[a-z0-9][a-z0-9-]{0,31}$/.test(name))
    return { ok: false, error: `invalid name "${name}" — use 1-32 chars of [a-z0-9-], starting alphanumeric` };
  if (!description) return { ok: false, error: 'description is required (shown in the roster)' };
  if (description.length > 600) return { ok: false, error: `description too long (${description.length} > 600)` };
  if (!systemPrompt) return { ok: false, error: 'systemPrompt is required' };
  if (systemPrompt.length > 4000) return { ok: false, error: `systemPrompt too long (${systemPrompt.length} > 4000)` };
  for (const t of tools)
    if (!(POOL_NAMES as readonly string[]).includes(t))
      return { ok: false, error: `unknown tool "${t}" — pool: ${POOL_NAMES.join(', ')}` };
  if (model.length > 80) return { ok: false, error: 'model too long' };
  const json: AgentJson = {
    name,
    description,
    tools,
    ...(hasMemory ? { hasMemory: true } : {}),
    ...(model ? { model } : {}),
  };
  return { ok: true, validated: { json, systemPrompt } };
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


