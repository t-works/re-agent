// Root resolution: three roots instead of one, so the core runs from any
// directory while code and mutable state stay separate.
//   CODE_ROOT  — this framework's install dir; read-only assets (system.txt,
//                agents/, runner.js, dist/). Derived from __dirname.
//   WORK_ROOT  — the project the agent works on: process.cwd() at launch.
//                run_command and spawned sub-agents inherit it, so every
//                command already operates on the project you launched from.
//   STATE_ROOT — writable per-project state: memory/{sessions,conversations,
//                agents} + runtime/agents/ (agents created this session).
//                Resolution order:
//                  1. $REACT_STATE_DIR (absolute, or relative to WORK_ROOT)
//                  2. <WORK_ROOT>/.react   when it already exists (opt-in)
//                  3. <WORK_ROOT>          when memory/ already exists (the
//                     framework's own repo keeps its legacy in-repo layout)
//                  4. ~/.react-agent/projects/<basename>-<hash8(abs path)>
//                So the framework repo still uses its existing memory/, while
//                any other project gets an isolated state dir keyed by path.
// Agents are discovered by merging roots (see lib/orchestrator.ts loadRegistry):
// project agents/, session-created runtime/agents/, the shared user roster at
// ~/.react-agent/agents/, then the shipped agents/ — nearest name wins.
import { existsSync } from 'fs';
import { createHash } from 'crypto';
import { homedir } from 'os';
import { basename, join, resolve } from 'path';

export const CODE_ROOT = join(__dirname, '..', '..'); // dist/lib -> project root
export const WORK_ROOT = process.cwd();

/** Shared state home; global agent roster lives at <HOME_ROOT>/agents. */
export function homeRoot(env: NodeJS.ProcessEnv = process.env): string {
  return env.REACT_HOME?.trim() || join(homedir(), '.react-agent');
}

export const HOME_ROOT = homeRoot();

/** Stable per-project state dir under HOME_ROOT (basename + path hash). */
export function projectStateDir(workRoot: string, env: NodeJS.ProcessEnv = process.env): string {
  const abs = resolve(workRoot);
  const slug = `${basename(abs).replace(/[^a-zA-Z0-9._-]/g, '_') || 'root'}-${createHash('sha1').update(abs).digest('hex').slice(0, 8)}`;
  return join(homeRoot(env), 'projects', slug);
}

/** The STATE_ROOT rule, pure enough to test; explicit env override wins. */
export function resolveStateRoot(workRoot: string, env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env.REACT_STATE_DIR?.trim();
  if (explicit) return resolve(workRoot, explicit);
  if (existsSync(join(workRoot, '.react'))) return join(workRoot, '.react');
  if (existsSync(join(workRoot, 'memory'))) return workRoot; // legacy in-repo layout
  return projectStateDir(workRoot, env);
}

export const STATE_ROOT = resolveStateRoot(WORK_ROOT);
