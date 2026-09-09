// Workspace artifact tools: task-scoped file exchange so sub-agents hand
// content to each other without round-tripping payloads through the
// orchestrator's context. Every delegation shares a per-session workspace dir
// (carried in task.json); reads/writes are path-validated against escaping it.
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'fs';
import { join, relative, sep } from 'path';
import type { Tool } from '../lib/react';

/**
 * Resolve a model-supplied artifact path inside workspace.
 * Rejects absolute paths, drive letters, '..' segments and empties.
 */
function artifactPath(workspace: string, raw: unknown): { path: string; error?: string } {
  const p = String(raw ?? '').trim().replace(/\\/g, '/');
  if (!p) return { path: '', error: 'artifact path is required' };
  const segs = p.split('/');
  if (p.startsWith('/') || /^[a-zA-Z]:/.test(p) || segs.includes('..') || segs.includes(''))
    return { path: '', error: `invalid artifact path "${p}" — use a relative path inside the workspace` };
  const abs = join(workspace, ...segs);
  if (abs !== workspace && !abs.startsWith(workspace + sep))
    return { path: '', error: `artifact path escapes the workspace: ${p}` };
  return { path: abs };
}

/** Every artifact file under workspace, as forward-slash relative paths. */
function listArtifacts(workspace: string): string[] {
  if (!existsSync(workspace)) return [];
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else out.push(relative(workspace, p).split(sep).join('/'));
    }
  };
  walk(workspace);
  return out;
}

export function makeArtifactTools(workspace: string): Tool[] {
  // Normalize to native separators (join single-arg) so startsWith checks below
  // never mix '/' and '\' on Windows when the workspace path came in as forward slashes.
  const ws = join(workspace.trim().replace(/[\\/]+$/, ''));
  return [
    {
      name: 'write_artifact',
      description: `Write a file into the shared session workspace (${ws}). Use it to hand your deliverable to the next agent: pick a short path (e.g. "research/findings.md"), write there, and report the path. Paths are relative to the workspace.`,
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'workspace-relative file path, e.g. "step1/report.md"' },
          content: { type: 'string', description: 'full file content (overwrites)' },
        },
        required: ['path', 'content'],
      },
      run: async (args) => {
        const { path, error } = artifactPath(ws, args.path);
        if (error) return { ok: false, output: error };
        try {
          mkdirSync(join(path, '..'), { recursive: true });
          writeFileSync(path, String(args.content ?? ''));
          return { ok: true, output: `wrote ${relative(ws, path).split(sep).join('/')} (${String(args.content ?? '').length} chars)` };
        } catch (e) {
          return { ok: false, output: `write failed: ${(e as Error).message}` };
        }
      },
    },
    {
      name: 'read_artifact',
      description: `Read a file from the shared session workspace (${ws}) that a previous agent wrote. Ask the previous agent (or the orchestrator) for the path. Paths are relative to the workspace.`,
      parameters: {
        type: 'object',
        properties: { path: { type: 'string', description: 'workspace-relative file path, e.g. "step1/report.md"' } },
        required: ['path'],
      },
      run: async (args) => {
        const { path, error } = artifactPath(ws, args.path);
        if (error) return { ok: false, output: error };
        try {
          return { ok: true, output: readFileSync(path, 'utf8') };
        } catch {
          const have = listArtifacts(ws);
          return {
            ok: false,
            output: `No artifact "${String(args.path)}" in the workspace. Available: ${have.join(', ') || '(none)'}`,
          };
        }
      },
    },
  ];
}
