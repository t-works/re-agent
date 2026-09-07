// Smoke check for the interface/core split: run `npm run build && node smoke.js`
// 1) reactLoop speaks the Responses API wire format and emits events without
//    printing on its own. 2) createOrchestrator builds without a terminal.
// 3) The tool round-trip and the unknown-tool recovery path work.
const assert = require('assert');
const { reactLoop } = require('./dist/lib/react');
const { createOrchestrator } = require('./dist/lib/orchestrator');

// --- canned Responses API bodies ---
const msg = (text) => ({
  type: 'message', role: 'assistant', status: 'completed',
  content: [{ type: 'output_text', text }],
});
const fnCall = (call_id, name, args) => ({
  type: 'function_call', id: 'it_' + call_id, call_id, name, arguments: args,
});
const resp = (...output) => ({ status: 'completed', output });

/** A fetch mock that serves one canned body per call, then fails if over-asked. */
function makeFetch(bodies) {
  let n = 0;
  return async () => {
    const body = bodies[n++];
    assert.ok(body, `fetch called more than expected (${n})`);
    return { ok: true, json: async () => body };
  };
}

const echoTool = {
  name: 'echo',
  description: 'echo back the input',
  parameters: { type: 'object', properties: { input: { type: 'string' } }, required: ['input'] },
  run: async (args) => ({ ok: true, output: 'echo:' + String(args.input) }),
};

(async () => {
  let printed = 0;
  const clog = console.log;
  console.log = () => { printed++; };

  // 1) No tools: a single final message is the answer, one assistant event.
  global.fetch = makeFetch([resp(msg('hello'))]);
  const seen1 = [];
  const r1 = await reactLoop({ systemPrompt: 's', task: 't', tools: [], onEvent: (e) => seen1.push(e) });
  assert.strictEqual(r1.output, 'hello');
  assert.deepStrictEqual(seen1.map((e) => e.kind), ['assistant']);

  // 2) Tool round-trip: commentary + function_call, then a final message.
  global.fetch = makeFetch([
    resp(msg('let me echo that'), fnCall('c1', 'echo', '{"input":"x"}')),
    resp(msg('done')),
  ]);
  const seen2 = [];
  const r2 = await reactLoop({
    systemPrompt: 's', task: 't', tools: [echoTool], onEvent: (e) => seen2.push(e),
  });
  assert.strictEqual(r2.output, 'done');
  assert.deepStrictEqual(seen2.map((e) => e.kind), ['assistant', 'observation', 'assistant']);
  assert.deepStrictEqual(seen2[1], { kind: 'observation', ok: true, output: 'echo:x' });

  // 3) Hallucinated tool: unknown name becomes an ERROR observation, loop recovers.
  global.fetch = makeFetch([resp(fnCall('c2', 'ghost', '{}')), resp(msg('recovered'))]);
  const seen3 = [];
  const r3 = await reactLoop({
    systemPrompt: 's', task: 't', tools: [echoTool], onEvent: (e) => seen3.push(e),
  });
  assert.strictEqual(r3.output, 'recovered');
  assert.strictEqual(seen3[0].ok, false);
  assert.ok(r3.log.some((l) => l.includes('Unknown tool: ghost')), 'log must name the unknown tool');

  console.log = clog;
  assert.strictEqual(printed, 0, 'core must not print to stdout');

  const orch = createOrchestrator(); // no terminal, no API key needed
  assert.ok(Array.isArray(orch.agents), 'registry must return an array');
  assert.strictEqual(typeof orch.ask, 'function');

  console.log(`smoke ok — core silent, ${orch.agents.length} sub-agents registered`);
})().catch((e) => { console.error(e); process.exit(1); });
