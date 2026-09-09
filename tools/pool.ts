// Data-agent tool pool: the fixed capability set a runner-spawned agent
// (agent.json with a `tools: string[]` list, no agent.ts) may be built from.
// Command tools are guardrail-wrapped here — same one-policy wiring the
// hand-written entries do, so a data agent's prompt can't widen tool access.
// POOL_NAMES doubles as the validation list create_agent checks against.
import type { Tool } from '../lib/react';
import type { ApprovalRequest } from '../lib/guard';
import { wrapGuarded } from '../lib/guard';
import { runCommand } from './run-command';
import { makeRunSshTool } from './ssh';
import { viewImage } from './view-image';
import { makeArtifactTools } from './artifact';
import { readMemoryTools } from '../lib/memory';

export const POOL_NAMES = ['run_command', 'run_ssh', 'view_image', 'read_artifact', 'write_artifact'] as const;

export function buildAgentTools(opts: {
  name: string;          // agent name (memory dir key when hasMemory)
  tools: string[];       // requested subset of POOL_NAMES; unknown names are ignored
  workspace?: string;    // artifact root from task.json (absent → no artifact tools)
  hasMemory?: boolean;   // adds read_spoke (writes stay with the memoryWriter)
  ask: (q: ApprovalRequest) => Promise<boolean>; // approval channel (mailbox in a spawned agent)
}): Tool[] {
  const want = new Set(opts.tools);
  const tools: Tool[] = [];
  if (want.has('run_command')) tools.push(wrapGuarded(runCommand, opts.ask));
  const ssh = want.has('run_ssh') ? makeRunSshTool() : undefined; // undefined when no hosts configured
  if (ssh) tools.push(wrapGuarded(ssh, opts.ask));
  if (want.has('view_image')) tools.push(viewImage);
  if (opts.workspace && (want.has('read_artifact') || want.has('write_artifact')))
    tools.push(...makeArtifactTools(opts.workspace));
  if (opts.hasMemory) tools.push(...readMemoryTools(opts.name));
  return tools;
}
