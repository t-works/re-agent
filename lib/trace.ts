// Turn tracing: append-only JSONL, one file per PROCESS (see
// docs/feat/tracing-PRD.md). The orchestrator writes
// memory/sessions/<sid>/trace.jsonl, each spawned sub-agent writes
// <taskDir>/trace.jsonl — one writer per file, so there is no interleaving to
// lock against. The parent gets the child's totals through result.json
// (lib/task.ts), so reading a turn's story needs no cross-file join unless you
// drill into a specific delegation.
//
// Transport-free core rule (AGENTS.md): this module only touches disk. The
// turn's one-line summary is RETURNED; the caller (CLI/API) decides to emit it.
// Tracing is best-effort: a failed write never fails a turn.
import { appendFileSync, mkdirSync } from 'fs';
import { dirname, relative } from 'path';
import { STATE_ROOT } from './roots';

/** Usage as reported by /responses. All optional — treat the API as a source we guess at. */
export type TraceUsage = {
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
  [k: string]: unknown;
};

/** Aggregates for one loop/turn; written as the turn record and echoed in result.json. */
export type TraceTotals = {
  ms: number;
  iterations: number;
  modelCalls: number;
  toolCalls: number;
  modelMs: number;
  toolMs: number;
  inputTokens: number;
  outputTokens: number;
  usageMissing: number; // model calls whose response carried no usage — how much we're guessing
  slowestTool?: { name: string; ms: number };
};

export type TraceSink = {
  file: string;
  model(r: {
    iter: number;
    model: string;
    effort: string;
    reqBytes: number;
    inputItems: number;
    tools: number;
    ms: number;
    ok: boolean;
    usage?: TraceUsage;
    inputBreakdown: Record<string, number>;
  }): void;
  tool(r: {
    iter: number;
    name: string;
    args: string;
    output: string;
    ok: boolean;
    ms: number;
    image?: boolean;
  }): void;
  delegate(r: { to: string; tid: string; ms: number; ok: boolean; child?: TraceTotals }): void;
  /** Append the turn record (always last) and return its totals + the summary line. */
  turn(r: { ok: boolean; sid?: string; convId?: string; question?: string }): { totals: TraceTotals; line: string };
};

const CLIP = 200; // snippet cap in REACT_TRACE=full — sizes are the point, content is the exception

/** REACT_TRACE=0|off|false disables writing and the summary line; 'full' adds clipped snippets. */
function traceMode(): 'off' | 'on' | 'full' {
  const v = (process.env.REACT_TRACE ?? '').trim().toLowerCase();
  if (v === '0' || v === 'off' || v === 'false') return 'off';
  return v === 'full' ? 'full' : 'on';
}

/**
 * Open a trace file for one process (or null when REACT_TRACE disables it).
 * owner.agent/owner.sid/owner.tid ride in every record's envelope so records
 * from different processes are still self-describing.
 */
export function makeTraceSink(
  file: string,
  owner: { agent: string; sid?: string; tid?: string }
): TraceSink | null {
  const mode = traceMode();
  if (mode === 'off') return null;
  try {
    mkdirSync(dirname(file), { recursive: true });
  } catch {
    /* best effort — the append below fails silently too */
  }
  const t0 = performance.now();
  const envelope = {
    agent: owner.agent,
    ...(owner.sid && { sid: owner.sid }),
    ...(owner.tid && { tid: owner.tid }),
  };
  let broken = false; // one failed write disables the sink for this turn
  const write = (rec: Record<string, unknown>) => {
    if (broken) return;
    try {
      appendFileSync(file, JSON.stringify({ t: new Date().toISOString(), pid: process.pid, ...envelope, ...rec }) + '\n');
    } catch {
      broken = true;
    }
  };
  const clip = (s: string) => (s.length > CLIP ? s.slice(0, CLIP) + `…(${s.length} chars)` : s);

  const totals: TraceTotals = {
    ms: 0, iterations: 0, modelCalls: 0, toolCalls: 0,
    modelMs: 0, toolMs: 0, inputTokens: 0, outputTokens: 0, usageMissing: 0,
  };

  return {
    file,
    model(r) {
      totals.modelCalls++;
      totals.iterations = Math.max(totals.iterations, r.iter + 1);
      totals.modelMs += r.ms;
      if (r.ok) {
        totals.inputTokens += r.usage?.input_tokens ?? 0;
        totals.outputTokens += r.usage?.output_tokens ?? 0;
        if (r.usage?.input_tokens == null) totals.usageMissing++;
      }
      write({
        kind: 'model', iter: r.iter, model: r.model, effort: r.effort,
        reqBytes: r.reqBytes, inputItems: r.inputItems, tools: r.tools, ms: r.ms, ok: r.ok,
        ...(r.usage ? { usage: r.usage } : {}),
        inputBreakdown: r.inputBreakdown,
      });
    },
    tool(r) {
      totals.toolCalls++;
      totals.toolMs += r.ms;
      if (!totals.slowestTool || r.ms > totals.slowestTool.ms) totals.slowestTool = { name: r.name, ms: r.ms };
      write({
        kind: 'tool', iter: r.iter, name: r.name,
        argsBytes: Buffer.byteLength(r.args), outBytes: Buffer.byteLength(r.output),
        ok: r.ok, ms: r.ms, ...(r.image ? { image: true } : {}),
        ...(mode === 'full' ? { args: clip(r.args), output: clip(r.output) } : {}),
      });
    },
    delegate(r) {
      write({ kind: 'delegate', to: r.to, tid: r.tid, ms: r.ms, ok: r.ok, ...(r.child ? { child: r.child } : {}) });
    },
    turn(r) {
      totals.ms = performance.now() - t0;
      write({
        kind: 'turn', ok: r.ok, ...(r.sid && { sid: r.sid }), ...(r.convId && { convId: r.convId }),
        ...(r.question != null && { questionChars: r.question.length }),
        ...totals,
      });
      const secs = (ms: number) => (ms / 1000).toFixed(1) + 's';
      const token = (n: number) => (n >= 1000 ? (n / 1000).toFixed(1) + 'k' : String(n));
      const where = relative(STATE_ROOT, file).split('\\').join('/');
      return {
        totals,
        line:
          `trace: ${totals.modelCalls} model calls, ${totals.toolCalls} tools, ${totals.iterations} iters, ` +
          `in ${token(totals.inputTokens)} tok / out ${token(totals.outputTokens)} tok, ${secs(totals.ms)} ` +
          `(model ${secs(totals.modelMs)}, tools ${secs(totals.toolMs)})` +
          (totals.usageMissing ? `, ${totals.usageMissing} without usage` : '') +
          (broken ? ', WRITE FAILED' : '') +
          ` -> ${where}`,
      };
    },
  };
}

/**
 * Serialized size of each request category. This is how "where did our context
 * go?" gets answered without storing a copy of the conversation: byte counts per
 * category per iteration. Purely a measurement of what we were about to send.
 */
export function inputBreakdown(instructions: string, input: unknown[]): Record<string, number> {
  const out: Record<string, number> = { instructions: Buffer.byteLength(instructions) };
  for (const item of input) {
    const t = (item as { type?: string }).type;
    const k = t === 'function_call' ? 'calls' : t === 'function_call_output' ? 'outputs' : t === 'reasoning' ? 'reasoning' : 'task';
    out[k] = (out[k] ?? 0) + Buffer.byteLength(JSON.stringify(item));
  }
  return out;
}
