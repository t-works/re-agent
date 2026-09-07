// Smoke check for the interface/core split: run `npm run build && node smoke.js`
// 1) reactLoop emits events and never prints on its own. 2) createOrchestrator
// builds without a terminal (registry + system prompt resolve from dist/lib).
const assert = require('assert');
const { reactLoop } = require('./dist/lib/react');
const { createOrchestrator } = require('./dist/lib/orchestrator');

(async () => {
  const seen = [];
  let printed = 0;
  const clog = console.log;
  console.log = () => { printed++; };
  global.fetch = async () => ({
    ok: true,
    json: async () => ({ choices: [{ message: { content: 'Thought: done\nFinal Answer: hello' } }] }),
  });
  const r = await reactLoop({ systemPrompt: 's', task: 't', tools: [], onEvent: (e) => seen.push(e) });
  console.log = clog;

  assert.strictEqual(r.output, 'hello');
  assert.strictEqual(printed, 0, 'core must not print to stdout');
  assert.deepStrictEqual(seen.map((e) => e.kind), ['assistant']);

  const orch = createOrchestrator(); // no terminal, no API key needed
  assert.ok(Array.isArray(orch.agents) && orch.agents.length > 0, 'registry must find sub-agents');
  assert.ok(orch.agents.some((a) => a.dir === 'SSH-AGENT'), 'SSH-AGENT must be registered');
  assert.strictEqual(typeof orch.ask, 'function');

  console.log(`smoke ok — core silent, ${orch.agents.map((a) => a.name).join(', ')} registered`);
})().catch((e) => { console.error(e); process.exit(1); });
