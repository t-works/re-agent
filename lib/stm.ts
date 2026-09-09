// Short-term memory: the conversation-level Q/A transcript on disk. Sessions
// (lib/orchestrator.ts) hold per-turn task mailboxes; this log records each
// turn's question + final answer under a stable conversation id, so a restarted
// process (CLI `restart`, crash recovery, `--resume <id>`) can rebuild context
// by loading the most recent turns. Raw and rolling by design — the boot loader
// clips, it never summarizes; long-term distillation stays in lib/memory.ts
// (the hasMemory knowledge base). Layout:
//   memory/conversations/last.txt                          the most recent conversation id
//   memory/conversations/<convId>/transcript.jsonl         one JSON object per turn
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

const SRC_ROOT = join(__dirname, '..', '..'); // dist/lib -> project root
const CONVERSATIONS_ROOT = join(SRC_ROOT, 'memory', 'conversations');

// Conv ids appear in file paths and come from argv — alnum/dot/dash/underscore only.
export function isValidConvId(id: string): boolean {
  return /^[a-zA-Z0-9._-]+$/.test(id);
}

export type StmTurn = { t: number; at: string; sid: string; q: string; output: string };

const transcriptFile = (convId: string) => join(CONVERSATIONS_ROOT, convId, 'transcript.jsonl');

/** Append one turn to a conversation's transcript (creates the dir/file). */
export function appendTurn(convId: string, turn: Omit<StmTurn, 't' | 'at'>): void {
  if (!isValidConvId(convId)) throw new Error(`bad conversation id: ${convId}`);
  const f = transcriptFile(convId);
  const prior = existsSync(f) ? readFileSync(f, 'utf8') : '';
  // Turn index = current line count; fine while a conversation lives in one file
  // (ponytail: index or shard if a transcript ever passes ~10k turns).
  const t = prior ? prior.trimEnd().split('\n').length : 0;
  const line = JSON.stringify({ t, at: new Date().toISOString(), ...turn });
  mkdirSync(join(CONVERSATIONS_ROOT, convId), { recursive: true });
  writeFileSync(f, prior + (prior ? '\n' : '') + line);
}

/** All turns, oldest first; corrupt lines are dropped, missing transcript = []. */
export function readTurns(convId: string): StmTurn[] {
  try {
    return readFileSync(transcriptFile(convId), 'utf8')
      .split('\n')
      .filter(Boolean)
      .flatMap((l) => {
        try { return [JSON.parse(l) as StmTurn]; } catch { return []; }
      });
  } catch {
    return [];
  }
}

const clip = (s: string, n: number) =>
  s.length > n ? s.slice(0, n).trimEnd() + ` … (${s.length} chars total)` : s;

/**
 * The last k turns rendered as a context block for a resumed boot. Restoring is
 * deliberately lossy-but-cheap (recent gist, not replay); full fidelity stays on
 * disk in the transcript.
 */
export function recentContext(convId: string, k = 10): { block: string; count: number } {
  const turns = readTurns(convId).slice(-k);
  if (!turns.length) return { block: '', count: 0 };
  const body = turns
    .map((x) => `You: ${clip(x.q, 400)}\nAgent: ${clip(x.output, 1500)}`)
    .join('\n\n');
  return {
    count: turns.length,
    block:
      'Conversation context restored from short-term memory (the most recent turns of this conversation, oldest first):\n\n' +
      body,
  };
}

/** Remember convId as the conversation a bare relaunch should resume. */
export function rememberLast(convId: string): void {
  mkdirSync(CONVERSATIONS_ROOT, { recursive: true });
  writeFileSync(join(CONVERSATIONS_ROOT, 'last.txt'), convId);
}

/** The id remembered by the last run, or null when none/invalid. */
export function lastConvId(): string | null {
  try {
    const id = readFileSync(join(CONVERSATIONS_ROOT, 'last.txt'), 'utf8').trim();
    return isValidConvId(id) ? id : null;
  } catch {
    return null;
  }
}
