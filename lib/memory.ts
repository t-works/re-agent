// Agent memory — The Directory Structure (Hub-and-Spoke Graph) on disk.
// Layout:  memory/agents/<agent-name>/index.md   (the HUB: one line per spoke)
//          memory/agents/<agent-name>/<topic>.md (SPOKES: one topic per file)
// Read side (on agent startup + on demand): the agent's system prompt gets the
// hub injected; read_spoke fetches a single spoke when the agent needs it.
// Write side (synthetic, end-of-session only): the orchestrator's finalize()
// runs one memoryWriter distillation pass per hasMemory agent over that CLI
// run's task/result transcripts, via write_spoke / write_index tools. Agents
// themselves never write their own memory — keeps the KB curated, not cluttered.
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import type { Tool } from './react';

const SRC_ROOT = join(__dirname, '..', '..'); // dist/lib -> project root
const AGENTS_MEMORY_ROOT = join(SRC_ROOT, 'memory', 'agents');

export type MemoryFile = { file: string; content: string };
export type MemoryContext = { hub: string | null; spokes: MemoryFile[] };

/** Path of an agent's memory dir; names are trusted (agent.json) but still sanitized. */
export function agentMemoryDir(agentName: string): string {
  return join(AGENTS_MEMORY_ROOT, agentName.replace(/[^a-z0-9_.-]/gi, '_'));
}

/** The hub (index.md) content, or null when the agent has no memory yet. */
export function readMemoryHub(agentName: string): string | null {
  try {
    return readFileSync(join(agentMemoryDir(agentName), 'index.md'), 'utf8');
  } catch {
    return null;
  }
}

/** All spoke files (index.md excluded) with their content, capped per file. */
export function loadMemoryContext(agentName: string, capPerSpoke = 4000): MemoryContext {
  const dir = agentMemoryDir(agentName);
  const hub = readMemoryHub(agentName);
  const spokes: MemoryFile[] = [];
  if (existsSync(dir)) {
    for (const f of readdirSync(dir).filter((f) => f.endsWith('.md') && f !== 'index.md')) {
      try {
        let content = readFileSync(join(dir, f), 'utf8');
        if (content.length > capPerSpoke) content = content.slice(0, capPerSpoke) + `\n… (truncated, full file ${content.length} chars)`;
        spokes.push({ file: f, content });
      } catch { /* skip unreadable */ }
    }
  }
  return { hub, spokes };
}

/** Build the memory section appended to a hasMemory agent's system prompt at startup. */
export function memoryHubSection(agentName: string): string {
  const hub = readMemoryHub(agentName);
  if (!hub) return '\n\n## Memory\nYou have no memory notes yet (first run).';
  return (
    '\n\n## Memory hub (index of your durable notes)\n' +
    hub +
    '\nFetch a note you need with the read_spoke tool. Notes are summaries of past sessions, not live state — verify current state on the host when it matters.'
  );
}

/** Map a tool-supplied spoke name to its file path, refusing anything outside the agent dir. */
function spokePath(agentName: string, spoke: string): { path: string; error?: string } {
  const name = String(spoke ?? '').trim().replace(/\.md$/i, '');
  if (!/^[a-z0-9_.-]+$/i.test(name)) return { path: '', error: `invalid spoke name: ${spoke}` };
  const dir = agentMemoryDir(agentName);
  const path = join(dir, name + '.md');
  if (!path.startsWith(dir)) return { path: '', error: `invalid spoke name: ${spoke}` };
  return { path };
}

/** Tools a hasMemory agent runs with: read spokes on demand (never write — the writer owns the KB). */
export function readMemoryTools(agentName: string): Tool[] {
  return [
    {
      name: 'read_spoke',
      description: 'Read one memory spoke note for this agent by topic name (no .md). Names are listed in your memory hub. Returns the note content or an error listing available spokes.',
      parameters: {
        type: 'object',
        properties: { spoke: { type: 'string', description: 'spoke topic name, e.g. "hosts" or "decisions"' } },
        required: ['spoke'],
      },
      run: async (args) => {
        const { path, error } = spokePath(agentName, String(args.spoke ?? ''));
        if (error) return { ok: false, output: error };
        try {
          return { ok: true, output: readFileSync(path, 'utf8') };
        } catch {
          const have = existsSync(agentMemoryDir(agentName))
            ? readdirSync(agentMemoryDir(agentName)).filter((f) => f.endsWith('.md')).join(', ') || '(none)'
            : '(none)';
          return { ok: false, output: `No spoke "${args.spoke}". Available memory files: ${have}` };
        }
      },
    },
  ];
}

/** Tools the memoryWriter distillation pass uses to update the KB. */
export function writeMemoryTools(agentName: string): Tool[] {
  const dir = agentMemoryDir(agentName);
  const writeSpoke = async (spoke: string, content: string) => {
    const { path, error } = spokePath(agentName, spoke);
    if (error) return { ok: false, output: error };
    mkdirSync(dir, { recursive: true });
    if (!String(content).trim()) {
      rmSync(path, { force: true });
      return { ok: true, output: `deleted ${spoke}.md` };
    }
    writeFileSync(path, String(content).trimEnd() + '\n');
    return { ok: true, output: `wrote ${spoke}.md (${String(content).length} chars)` };
  };
  return [
    { name: 'write_spoke', description: 'Create or fully replace a spoke note <topic>.md in this agent\'s memory dir. Empty content deletes the spoke. One topic per file.', parameters: { type: 'object', properties: { spoke: { type: 'string', description: 'topic name (no .md)' }, content: { type: 'string', description: 'full markdown content; empty deletes the spoke' } }, required: ['spoke', 'content'] }, run: (a) => writeSpoke(String(a.spoke ?? ''), String(a.content ?? '')) },
    { name: 'write_index', description: 'Fully replace the hub file index.md — one "- <topic>.md — summary" line per spoke plus an optional header. Must reflect the real spoke set after your edits.', parameters: { type: 'object', properties: { content: { type: 'string', description: 'full new index.md content' } }, required: ['content'] }, run: async (a) => { mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, 'index.md'), String(a.content ?? '').trimEnd() + '\n'); return { ok: true, output: 'wrote index.md' }; } },
  ];
}

/**
 * memoryWriter instructions. Runs at end of a CLI session (orchestrator.finalize)
 * per hasMemory agent that did work — one distillation LLM call per agent.
 */
export const MEMORY_WRITER_SYSTEM = `You are memoryWriter. You consolidate completed agent sessions into durable memory for ONE agent, using The Directory Structure (Hub-and-Spoke Graph):

- The agent's memory lives in memory/agents/<agent-name>/: a hub file index.md plus spoke notes (<topic>.md).
- index.md is the HUB: a short header plus one line per spoke:
  - <topic>.md — one-line summary of what the note covers
- Each spoke file is one topic of durable, synthetic knowledge a future session of the agent will want: host topology and facts, config decisions and the why, quirks/gotchas, safe workflows that worked, conventions. Write it as if for a future colleague.

Your tools:
- write_spoke(spoke, content) — create or FULLY REPLACE a spoke; empty content deletes it.
- write_index(content) — FULLY REPLACE the hub.

Rules:
- Keep only durable knowledge worth a future session's time. Never copy session transcripts, raw command dumps, or logs — condense to the lesson/fact.
- The current hub and spoke contents are shown in your task context and are authoritative; when changing a spoke you must rewrite its full content (no append).
- Prefer updating an existing spoke over creating a near-duplicate; if you merge, delete, or rename spokes, index.md must end up matching the real spoke set.
- Keep index.md compact (header + one summary line per spoke).
- Nothing durable emerged and your notes still stand: reply "no memory updates" and call no tools. Do not invent facts that are not in the sessions.`;
