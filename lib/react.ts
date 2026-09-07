// Shared agent loop over the DeepSeek Responses API: an agent = a system
// prompt + a set of tools + a task. The model calls tools natively
// (function_call output items); we run each call, feed the result back as a
// function_call_output item, and repeat until the model answers with a plain
// message. Stateless: the full history rides along in `input` every request.
import { exec } from 'child_process';
import cfg from '../config';

export type Tool = {
  name: string;
  description: string;                 // goes to the API — tells the model when/why to call
  parameters: Record<string, unknown>; // JSON Schema the API validates arguments against
  run: (args: Record<string, unknown>) => Promise<{ ok: boolean; output: string }>;
};
export type LoopResult = { ok: boolean; output: string; log: string[] };

// What happened during a loop step. Emitted to the caller (CLI prints, API
// streams/ignores) — the core never writes to stdout itself.
export type LoopEvent =
  | { kind: 'assistant'; content: string } // model text: commentary, or the final answer
  | { kind: 'observation'; ok: boolean; output: string };

/** Convenience renderer for CLI drivers, reproduces the old inline console.logs. */
export function printLoopEvent(e: LoopEvent) {
  if (e.kind === 'assistant') console.log('\n' + e.content + '\n' + '-'.repeat(60));
  else console.log(`Observation: ${e.ok ? 'ok' : 'ERROR'}: ${e.output || '(empty)'}`);
}

// ---- Responses API wire types (the subset we touch) ----
export type InputItem =
  | { role: 'user'; content: string }
  | { type: 'function_call'; id: string; call_id: string; name: string; arguments: string }
  | { type: 'function_call_output'; call_id: string; output: string };

type OutItem =
  | { type: 'function_call'; id: string; call_id: string; name: string; arguments: string }
  | { type: 'message'; content: { type: 'output_text'; text: string }[] }
  | { type: 'reasoning' };

type ResponseBody = {
  status: 'completed' | 'incomplete' | 'failed';
  output: OutItem[];
  incomplete_details?: { reason?: string } | null;
  error?: { message?: string } | null;
};

/** Post one stateless turn to /responses and return the (completed) response. */
async function postResponses(opts: {
  model: string;
  reasoningEffort: string;
  instructions: string;
  input: InputItem[];
  tools: Tool[];
}): Promise<ResponseBody> {
  const res = await fetch(cfg.baseURL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` },
    body: JSON.stringify({
      model: opts.model,
      reasoning: { effort: opts.reasoningEffort },
      instructions: opts.instructions,
      input: opts.input,
      tools: opts.tools.map((t) => ({
        type: 'function',
        name: t.name,
        description: t.description,
        parameters: t.parameters,
      })),
      max_output_tokens: cfg.maxOutputTokens,
    }),
  });
  if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);
  const body = (await res.json()) as ResponseBody;
  if (body.status === 'failed') throw new Error(`API failed: ${body.error?.message ?? 'unknown error'}`);
  if (body.status === 'incomplete')
    throw new Error(`API incomplete: ${body.incomplete_details?.reason ?? 'unknown reason'}`);
  return body;
}

/** Run a tool against parsed, validated JSON args; any failure becomes tool output so the model can recover. */
async function runSafely(tool: Tool, argumentsJson: string) {
  let args: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(argumentsJson);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
      throw new Error('arguments must be a JSON object');
    args = parsed as Record<string, unknown>;
  } catch (e) {
    return { ok: false, output: `Invalid tool arguments: ${(e as Error).message}` };
  }
  try {
    return await tool.run(args);
  } catch (e) {
    return { ok: false, output: `Tool crashed: ${(e as Error).message}` };
  }
}

/**
 * Run the agent loop: the model emits function_call items, we run the tools and
 * feed the results back, until the model answers with a plain message. Per-role
 * overrides fall back to config defaults (orchestrator passes its own pair).
 */
export async function reactLoop({
  systemPrompt,
  task,
  tools,
  onEvent,
  model,
  reasoningEffort,
}: {
  systemPrompt: string;
  task: string;
  tools: Tool[];
  onEvent?: (e: LoopEvent) => void;
  model?: string;
  reasoningEffort?: string;
}): Promise<LoopResult> {
  const log: string[] = [];
  const usedModel = model ?? cfg.model;
  const usedEffort = reasoningEffort ?? cfg.reasoningEffort;
  // Stateless history: the task message, then one function_call + its
  // function_call_output per executed tool. Model commentary is shown but not
  // echoed back — the call items carry all the state.
  const history: InputItem[] = [{ role: 'user', content: task }];

  for (let i = 0; i < cfg.maxIterations; i++) {
    const body = await postResponses({
      model: usedModel,
      reasoningEffort: usedEffort,
      instructions: systemPrompt,
      input: history,
      tools,
    });
    const calls = body.output.filter((o): o is Extract<OutItem, { type: 'function_call' }> => o.type === 'function_call');
    const texts = body.output
      .filter((o) => o.type === 'message')
      .flatMap((o) => o.content.map((c) => c.text));
    for (const t of texts) {
      onEvent?.({ kind: 'assistant', content: t });
      log.push(t);
    }

    // No tool calls in this response → the message(s) are the final answer.
    // (Parallel calling is always enabled, so a response may carry several.)
    if (calls.length === 0) {
      if (texts.length === 0)
        return { ok: false, output: 'Model produced neither a tool call nor an answer.', log };
      return { ok: true, output: texts.join('\n').trim(), log };
    }

    for (const call of calls) {
      const tool = tools.find((t) => t.name === call.name);
      const result = tool
        ? await runSafely(tool, call.arguments)
        : { ok: false, output: `Unknown tool: ${call.name}. Known: ${tools.map((t) => t.name).join(', ')}` };
      history.push({
        type: 'function_call',
        id: call.id,
        call_id: call.call_id,
        name: call.name,
        arguments: call.arguments,
      });
      history.push({
        type: 'function_call_output',
        call_id: call.call_id,
        output: result.ok ? result.output : 'ERROR: ' + result.output,
      });
      onEvent?.({ kind: 'observation', ok: result.ok, output: result.output });
      log.push(`Observation: ${result.ok ? 'ok' : 'ERROR'}: ${result.output || '(empty)'}`);
    }
  }
  return { ok: false, output: 'Max iterations reached.', log };
}

/** Generic local shell tool (used by the orchestrator). */
export const runCommand: Tool = {
  name: 'run_command',
  description:
    "Run a shell command on this local machine and return its output. Use it for anything on this machine: filesystem, running programs, facts you don't know.",
  parameters: {
    type: 'object',
    properties: { command: { type: 'string', description: 'the exact shell command to run' } },
    required: ['command'],
  },
  run: (args) =>
    new Promise((resolve) => {
      exec(String(args.command ?? ''), { timeout: 30000 }, (err, stdout, stderr) => {
        if (err) resolve({ ok: false, output: (stderr || err.message).trim() });
        else resolve({ ok: true, output: stdout.trim() });
      });
    }),
};
