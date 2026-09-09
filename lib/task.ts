// Shared sub-agent mailbox contract. The orchestrator's delegate() writes
// task.json (with optional per-agent model/reasoningEffort forwarded from
// agent.json); the spawned agent entry reads it, runs its loop, and writes
// result.json. Centralized so a new sub-agent inherits model selection by just
// passing task.model to reactLoop (reactLoop falls back to cfg defaults).
import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

export type SubTask = {
  id: string;
  from?: string;
  to?: string;
  task: string;
  workspace?: string; // shared artifact dir (memory/sessions/<sid>/workspace) for file handoffs
  model?: string;
  reasoningEffort?: string;
};

/** Parse task.json from the mailbox dir handed to the child process. */
export function readTask(taskDir: string): SubTask {
  return JSON.parse(readFileSync(join(taskDir, 'task.json'), 'utf8')) as SubTask;
}

/** Write result.json into the mailbox dir (what delegate() waits for). */
export function writeResult(
  taskDir: string,
  r: { id: string; from: string; ok: boolean; output: string; log: string[] }
): void {
  writeFileSync(join(taskDir, 'result.json'), JSON.stringify(r, null, 2));
}
