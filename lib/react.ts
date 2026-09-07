// Shared ReAct loop: any agent = a system prompt + a set of tools + a task.
import { exec } from 'child_process';
import cfg from '../config';

export type Tool = { name: string; run: (input: string) => Promise<{ ok: boolean; output: string }> };
export type Message = { role: 'system' | 'user' | 'assistant'; content: string };
export type LoopResult = { ok: boolean; output: string; log: string[] };

// What happened during a loop step. Emitted to the caller (CLI prints, API
// streams/ignores) — the core never writes to stdout itself.
export type LoopEvent =
  | { kind: 'assistant'; content: string }
  | { kind: 'observation'; ok: boolean; output: string };

// Convenience renderer for CLI drivers, reproduces the old inline console.logs.
export function printLoopEvent(e: LoopEvent) {
  if (e.kind === 'assistant') console.log('\n' + e.content + '\n' + '-'.repeat(60));
  else console.log(`Observation: ${e.ok ? 'ok' : 'ERROR'}: ${e.output || '(empty)'}`);
}

async function askLLM(messages: Message[]): Promise<string> {
  const res = await fetch(cfg.baseURL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` },
    body: JSON.stringify({ model: cfg.model, messages, temperature: 0 }),
  });
  if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);
  return (await res.json()).choices[0].message.content;
}

export async function reactLoop(opts: {
  systemPrompt: string;
  task: string;
  tools: Tool[];
  onEvent?: (e: LoopEvent) => void;
}): Promise<LoopResult> {
  const log: string[] = [];
  const messages: Message[] = [
    { role: 'system', content: opts.systemPrompt },
    { role: 'user', content: opts.task },
  ];
  for (let i = 0; i < cfg.maxIterations; i++) {
    const reply = await askLLM(messages);
    opts.onEvent?.({ kind: 'assistant', content: reply });
    log.push(reply);
    const final = reply.match(/Final Answer:\s*([\s\S]*)/);
    if (final) return { ok: true, output: final[1].trim(), log };

    const action = reply.match(/Action:\s*(\w+)/);
    const input = reply.match(/Action Input:\s*([\s\S]*)/);
    if (!action || !input) return { ok: false, output: 'Model stopped without a Final Answer.', log };
    const tool = opts.tools.find((t) => t.name === action[1]);
    if (!tool) {
      return {
        ok: false,
        output: `Unknown action: ${action[1]}. Known: ${opts.tools.map((t) => t.name).join(', ')}`,
        log,
      };
    }

    messages.push({ role: 'assistant', content: reply });
    const { ok, output } = await tool.run(input[1].trim());
    opts.onEvent?.({ kind: 'observation', ok, output });
    log.push(`Observation: ${ok ? 'ok' : 'ERROR'}: ${output || '(empty)'}`);
    messages.push({ role: 'user', content: `Observation: ${ok ? output : 'ERROR: ' + output}` });
  }
  return { ok: false, output: 'Max iterations reached.', log };
}

// Generic local shell tool (used by the orchestrator).
export const runCommand: Tool = {
  name: 'run_command',
  run: (input: string) =>
    new Promise((resolve) => {
      exec(input, { timeout: 30000 }, (err, stdout, stderr) => {
        if (err) resolve({ ok: false, output: (stderr || err.message).trim() });
        else resolve({ ok: true, output: stdout.trim() });
      });
    }),
};
