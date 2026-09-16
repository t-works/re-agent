#!/usr/bin/env node
// CLI front-end: readline ⇄ orchestrator core (lib/orchestrator.ts). No agent
// logic here — swap this file for an HTTP front-end and the core is unchanged.
// Run: npm run build && node dist/agent.js [--new | --resume <convId>]
// Continuity across boots: each turn's Q/A is logged to short-term memory
// (lib/stm.ts, memory/conversations/<convId>/transcript.jsonl). A bare start
// resumes the last conversation; `restart` at the prompt reboots this process
// *in place* — it drops its own compiled modules and boots again, so boot-time
// state (config, agent registry, compiled sub-agents) reloads from disk while
// the conversation context rides back in from the short-term transcript.
import { createInterface } from 'readline';
import { randomUUID } from 'crypto';
import { sep } from 'path';
import type { Interface } from 'readline';
import type { TurnEvent } from './lib/orchestrator';
import type { ApprovalRequest } from './lib/guard';

const REBOOT_COMMANDS = ['new', 'restart'] as const;
const QUIT_COMMANDS = ['quit', 'exit', 'q'] as const;
type RebootCommandNames = (typeof REBOOT_COMMANDS)[number];
type CommandNames = RebootCommandNames | (typeof QUIT_COMMANDS)[number];

// Boot-time module graph. loadCore() re-requires it on every boot so a reboot
// really rebuilds configuration, the registry and the compiled sub-agents
// instead of reusing this process's stale copies; the type-only imports above
// are erased by the compiler, so nothing here is pinned to the first load.
type Core = {
  cfg: typeof import('./conf/config').default;
  orchestrator: typeof import('./lib/orchestrator');
  react: typeof import('./lib/react');
  roots: typeof import('./lib/roots');
  stm: typeof import('./lib/stm');
};

function loadCore(): Core {
  return {
    cfg: require('./conf/config').default,
    orchestrator: require('./lib/orchestrator'),
    react: require('./lib/react'),
    roots: require('./lib/roots'),
    stm: require('./lib/stm'),
  };
}

/** Drop this package's compiled modules (dist/**, never our own entry file and
 * never a node_modules dependency) from the require cache, so the next
 * loadCore() rebuilds the whole graph from what is on disk right now. */
function purgeCore(): void {
  const prefix = __dirname + sep;
  for (const id of Object.keys(require.cache)) {
    if (id === __filename || !id.startsWith(prefix)) continue;
    if (id.slice(prefix.length).split(sep).includes('node_modules')) continue;
    delete require.cache[id];
  }
}

type Boot = { convId: string; resumed: boolean; count: number; context: string };

/** Conversation boot: --new = fresh, --resume <id> = pick one, bare start =
 * resume the last conversation (continuity by default). */
function resolveConversation(argv: string[], stm: Core['stm']): Boot {
  let mode: 'last' | 'new' | 'resume' = 'last';
  let resumeId = '';
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--new') mode = 'new';
    else if (a === '--resume') {
      resumeId = argv[++i] ?? '';
      if (!stm.isValidConvId(resumeId)) throw new Error(`bad conversation id for --resume: ${resumeId || '(missing)'}`);
      mode = 'resume';
    } else throw new Error(`unknown argument: ${a} (use --new or --resume <id>)`);
  }
  const pick = (convId: string) => {
    const { block, count } = stm.recentContext(convId);
    return { convId, resumed: true, count, context: block };
  };
  if (mode === 'resume') return pick(resumeId);
  const last = mode === 'last' ? stm.lastConvId() : null;
  if (last) return pick(last);
  return { convId: 'c' + randomUUID().replace(/-/g, '').slice(0, 12), resumed: false, count: 0, context: '' };
}

/** One full boot: fresh modules, fresh conversation wiring, fresh prompt. The
 * reboot path calls this again after purging, so a `restart` is just boot N+1
 * of the same process — the terminal, its stdin and the approval prompt are
 * never handed to another process. */
async function bootUp(argv: string[]): Promise<void> {
  purgeCore();
  const core = loadCore();

  if (!core.cfg.apiKey) { console.error('Set DEEPSEEK_API_KEY first.'); process.exit(1); }

  let boot: Boot;
  try {
    boot = resolveConversation(argv, core.stm);
  } catch (e) {
    console.error('Error:', (e as Error).message);
    process.exit(1);
  }
  const { convId } = boot;
  core.stm.rememberLast(convId); // a bare relaunch keeps returning to this conversation

  // Render loop events like the traces always looked; side notes are raw text.
  const emit = (e: TurnEvent) => (e.kind === 'note' ? process.stdout.write(e.content) : core.react.printLoopEvent(e));

  // Human approval gate for guardrailed commands (orchestrator tools and, via the
  // mailbox relay, the config-editor sub-agent). No readline question is pending
  // while a turn runs, so asking on the same interface is safe.
  let rl!: Interface;
  const confirm = (q: ApprovalRequest) =>
    new Promise<boolean>((resolve) => {
      rl.question(`\n? approve [${q.tool}] ${q.command}\n  (${q.reason}) — y/N: `, (a) => resolve(/^y(es)?$/i.test(a.trim())));
    });

  // convId opts the core into short-term memory (every turn is appended to the
  // transcript); resumeContext rides in this boot's system prompt only.
  const orchestrator = core.orchestrator.createOrchestrator(emit, confirm, { convId, resumeContext: boot.context });

  rl = createInterface({ input: process.stdin, output: process.stdout });
  const sids: string[] = []; // every turn's session id — handed to finalize() for memory consolidation
  let closed = false;
  rl.on('close', () => { closed = true; });

  // End of this boot: consolidate long-term memory over its sessions, then
  // either reboot in place (restart/new) or exit. Runs only between turns (no
  // approval pending). The reboot is deliberately in-process: on Windows a
  // spawned child either loses this terminal (detached → not attached to the
  // console, so its output and its stdin are gone) or dies with it when this
  // process exits (attached) — a relaunch the user cannot see, which is exactly
  // the bug this replaces.
  const shutdown = async (command: CommandNames) => {
    if (closed) return;
    closed = true;
    rl.close();
    const m = await orchestrator.finalize(sids).catch(() => null);
    if (m?.output && !m.output.startsWith('no memory')) console.log('\n' + m.output);

    if (REBOOT_COMMANDS.includes(command as RebootCommandNames)) {
      const restarting = command === 'restart';
      console.log(restarting
        ? `\nRestarting — reloading this process; conversation ${convId} resumes from short-term memory.`
        : '\nStarting new session.');
      await bootUp(['node', 'agent', restarting ? '--resume' : '--new', ...(restarting ? [convId] : [])]);
      return;
    }
    process.exit(0);
  };

  const prompt = () => rl.question('\nYou: ', async (q) => {
    const cmd = q.trim().toLowerCase();
    if ([...REBOOT_COMMANDS, ...QUIT_COMMANDS].includes(cmd as CommandNames)) return shutdown(cmd as CommandNames);
    try {
      const result = await orchestrator.ask(q);
      sids.push(result.sid);
      console.log('\nAgent: ' + result.output);
    } catch (e) {
      console.error('Error:', (e as Error).message);
    }
    if (!closed) prompt();
  });

  console.log(
    `Orchestrator ready. Sub-agents: ${orchestrator.agents.map((a) => a.name).join(', ') || '(none)'}\n` +
    `Working dir: ${core.roots.WORK_ROOT}\n` +
    `State:       ${core.roots.STATE_ROOT}\n` +
    `Conversation ${convId} — ${boot.resumed ? `resumed (last ${boot.count} turn${boot.count === 1 ? '' : 's'} in context)` : 'new'}` +
    '  (q = quit, restart = reload modules and boot again)'
  );
  prompt();
}

bootUp(process.argv).catch((e) => { console.error('Error:', (e as Error).message); process.exit(1); });
