// Shared agent loop over the DeepSeek Responses API: an agent = a system
// prompt + a set of tools + a task. The model calls tools natively
// (function_call output items); we run each call, feed the result back as a
// function_call_output item, and repeat until the model answers with a plain
// message. Stateless: the full history rides along in `input` every request.
import cfg from '../conf/config';
import { inputBreakdown, type TraceSink, type TraceUsage } from './trace';

export type Tool = {
  name: string;
  description: string;                 // goes to the API — tells the model when/why to call
  parameters: Record<string, unknown>; // JSON Schema the API validates arguments against
  run: (args: Record<string, unknown>) => Promise<ToolResult>;
};

// A tool result may carry one image for vision models (http(s) URL or base64 data
// URL). reactLoop serializes it into an input_image content part inside the
// function_call_output item — the DeepSeek Responses API route for "the model can
// see what a tool returned" (deepseek-v4-flash-vision-exp only; other models get
// a placeholder). Abstraction point: swap the transport per image later (e.g. a
// Files API file_id ref) without touching the loop.
export type ToolImage = { url: string; detail?: 'low' | 'high' | 'original' | 'auto' };
export type ToolResult = { ok: boolean; output: string; image?: ToolImage };

// Content parts the client may put in a function_call_output item. Live API
// check: DeepSeek only accepts the input_* variants here (400 on output_text:
// "expected one of input_text, input_image, input_file").
export type OutputPart =
  | { type: 'input_text'; text: string }
  | { type: 'input_image'; image_url: string; detail?: string };

/** Serialize a tool result: plain string output, or content parts when the tool returned an image. */
export function toolOutputParts(r: ToolResult): string | OutputPart[] {
  if (!r.image) return (r.ok ? '' : 'ERROR: ') + r.output;
  const text = (r.ok ? '' : 'ERROR: ') + r.output;
  const parts: OutputPart[] = text ? [{ type: 'input_text', text }] : [];
  const img: OutputPart = { type: 'input_image', image_url: r.image.url };
  if (r.image.detail) (img as { detail?: string }).detail = r.image.detail;
  parts.push(img);
  return parts;
}
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
  | { type: 'function_call_output'; call_id: string; output: string | OutputPart[] }
  // A reasoning item echoed back verbatim from a previous response. DeepSeek's
  // /responses 400s ("reasoning_text ... must be passed back to the API") when a
  // turn's follow-up request drops the prior reasoning item.
  | { type: 'reasoning'; [k: string]: unknown };

type OutItem =
  | { type: 'function_call'; id: string; call_id: string; name: string; arguments: string }
  | { type: 'message'; content: { type: 'output_text'; text: string }[] }
  | { type: 'reasoning' };

type ResponseBody = {
  status: 'completed' | 'incomplete' | 'failed';
  output: OutItem[];
  incomplete_details?: { reason?: string } | null;
  error?: { message?: string } | null;
  usage?: TraceUsage; // present in practice, but never required: absent usage must not break a turn
};

/** Post one stateless turn to /responses and return the (completed) response. */
async function postResponses(opts: {
  model: string;
  reasoningEffort: string;
  instructions: string;
  input: InputItem[];
  tools: Tool[];
  iter: number;
  trace?: TraceSink | null;
}): Promise<ResponseBody> {
  // Serialize once so the request can be measured (tracing) without changing it.
  const payload = JSON.stringify({
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
  });
  const t0 = performance.now();
  let usage: TraceUsage | undefined;
  let ok = false;
  try {
    const res = await fetch(cfg.baseURL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` },
      // No timeout = a stalled connection hangs the whole turn forever (seen live:
      // an idle process with no children, wedged mid-fetch). 5 min is generous for
      // a long effort-high reasoning response; a dead socket errors instead of hangs.
      signal: AbortSignal.timeout(300_000),
      body: payload,
    });
    if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);
    const body = (await res.json()) as ResponseBody;
    usage = body.usage; // captured before the status checks: a failed response still counts
    if (body.status === 'failed') throw new Error(`API failed: ${body.error?.message ?? 'unknown error'}`);
    if (body.status === 'incomplete')
      throw new Error(`API incomplete: ${body.incomplete_details?.reason ?? 'unknown reason'}`);
    ok = true;
    return body;
  } finally {
    // Recorded on every path — a wedged call must show up as a ~300000 ms record.
    opts.trace?.model({
      iter: opts.iter,
      model: opts.model,
      effort: opts.reasoningEffort,
      reqBytes: Buffer.byteLength(payload),
      inputItems: opts.input.length,
      tools: opts.tools.length,
      ms: performance.now() - t0,
      ok,
      usage,
      inputBreakdown: inputBreakdown(opts.instructions, opts.input),
    });
  }
}

/** Run a tool against parsed, validated JSON args; any failure becomes tool output so the model can recover. */
async function runSafely(tool: Tool, argumentsJson: string): Promise<ToolResult> {
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
  trace,
  model,
  reasoningEffort,
}: {
  systemPrompt: string;
  task: string;
  tools: Tool[];
  onEvent?: (e: LoopEvent) => void;
  trace?: TraceSink | null;
  model?: string;
  reasoningEffort?: string;
}): Promise<LoopResult> {
  const log: string[] = [];
  const usedModel = model ?? cfg.model;
  const usedEffort = reasoningEffort ?? cfg.reasoningEffort;
  // Stateless history: the task message, then one function_call + its
  // function_call_output per executed tool, plus any reasoning items echoed
  // back verbatim (see below). Model commentary is shown but not echoed back
  // — the call items carry all the state.
  const history: InputItem[] = [{ role: 'user', content: task }];

  for (let i = 0; i < cfg.maxIterations; i++) {
    const body = await postResponses({
      model: usedModel,
      reasoningEffort: usedEffort,
      instructions: systemPrompt,
      input: history,
      tools,
      iter: i,
      trace,
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

    // The next request of this turn must carry the response's reasoning items
    // back verbatim (reasoning always precedes the function_calls in output).
    // Not needed on the final answer above — no follow-up request is made.
    for (const o of body.output) if (o.type === 'reasoning') history.push(o as InputItem);

    // Run every tool first (observations stream as they finish), but stage the
    // history items: the follow-up request must list ALL function_calls before
    // ANY function_call_output. DeepSeek's thinking-mode continuation 400s with
    // "reasoning_text ... must be passed back to the API" when outputs are
    // interleaved between parallel calls.
    const done: { call: (typeof calls)[number]; result: ToolResult }[] = [];
    for (const call of calls) {
      const tool = tools.find((t) => t.name === call.name);
      const t0 = performance.now();
      const result = tool
        ? await runSafely(tool, call.arguments)
        : { ok: false, output: `Unknown tool: ${call.name}. Known: ${tools.map((t) => t.name).join(', ')}` };
      trace?.tool({
        iter: i, name: call.name, args: call.arguments, output: result.output,
        ok: result.ok, ms: performance.now() - t0, image: !!result.image,
      });
      done.push({ call, result });
      onEvent?.({ kind: 'observation', ok: result.ok, output: result.output });
      log.push(`Observation: ${result.ok ? 'ok' : 'ERROR'}: ${result.output || '(empty)'}`);
    }
    for (const { call } of done) {
      history.push({
        type: 'function_call',
        id: call.id,
        call_id: call.call_id,
        name: call.name,
        arguments: call.arguments,
      });
    }
    for (const { call, result } of done) {
      history.push({
        type: 'function_call_output',
        call_id: call.call_id,
        output: toolOutputParts(result),
      });
    }
  }
  return { ok: false, output: 'Max iterations reached.', log };
}
