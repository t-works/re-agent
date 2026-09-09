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
  assert.strictEqual(typeof orch.finalize, 'function');
  const ce = orch.agents.find((a) => a.name === 'config-editor');
  assert.ok(ce, 'config-editor must be registered');
  assert.strictEqual(ce.hasMemory, true, 'config-editor hasMemory flag must be picked up from agent.json');
  const vision = orch.agents.find((a) => a.name === 'vision');
  assert.ok(vision, 'vision must be registered');
  assert.strictEqual(vision.model, 'deepseek-v4-flash-vision-exp', 'agent.json model field must reach the registry');
  assert.strictEqual(vision.hasMemory, false, 'vision opts out of memory');
  assert.strictEqual(ce.model, undefined, 'agents without a model field must not fabricate one');

  console.log = clog;
  assert.strictEqual(printed, 0, 'core must not print to stdout');

  // --- 4) Guardrail classification: deny/ask/allow; ask rules are ssh-scoped ---
  const { classifyCommand, wrapGuarded, makeMailboxAsker } = require('./dist/lib/guard');
  const { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } = require('fs');
  const { tmpdir } = require('os');
  const { join } = require('path');
  assert.strictEqual(classifyCommand('rm -rf /', 'run_ssh'), 'deny');
  assert.strictEqual(classifyCommand('cat /etc/hosts', 'run_ssh'), 'allow');
  assert.strictEqual(classifyCommand('systemctl restart nginx', 'run_command'), 'allow', 'ask rules must not fire on the local tool');
  assert.deepStrictEqual(
    classifyCommand('systemctl restart nginx', 'run_ssh'),
    { tool: 'run_ssh', command: 'systemctl restart nginx', reason: 'service state change' }
  );
  assert.strictEqual(classifyCommand('echo x > /etc/nginx/nginx.conf', 'run_ssh') !== 'allow', true, 'writes into /etc must ask');

  // --- 5) wrapGuarded: deny never executes, ask denied never executes, ask approved runs ---
  let toolCalls = 0;
  const mkTool = () => ({ name: 'run_ssh', description: '', parameters: {}, run: async () => { toolCalls++; return { ok: true, output: 'ran' }; } });
  let asked = 0;
  const rDeny = await wrapGuarded(mkTool(), async () => { asked++; return true; }).run({ command: 'rm -rf /' });
  assert.strictEqual(rDeny.ok, false);
  assert.ok(rDeny.output.includes('DENIED'));
  assert.strictEqual(toolCalls, 0, 'deny must not reach the underlying tool');
  assert.strictEqual(asked, 0, 'deny must not ask');
  const rAskNo = await wrapGuarded(mkTool(), async () => false).run({ command: 'systemctl restart nginx' });
  assert.strictEqual(rAskNo.ok, false);
  assert.ok(rAskNo.output.includes('DENIED by user'));
  assert.strictEqual(toolCalls, 0, 'denied approval must not reach the underlying tool');
  const rAskYes = await wrapGuarded(mkTool(), async () => true).run({ command: 'systemctl restart nginx' });
  assert.strictEqual(rAskYes.ok, true);
  assert.strictEqual(toolCalls, 1, 'approved ask must execute');

  // --- 6) Mailbox approval roundtrip (child side) + stale-answer safety ---
  const box = mkdtempSync(join(tmpdir(), 'askbox-'));
  const asker = makeMailboxAsker(box, { pollIntervalMs: 20, approveTimeoutMs: 2000 });
  const approve = setTimeout(() => writeFileSync(join(box, 'answer.json'), JSON.stringify({ approved: true })), 60);
  assert.strictEqual(await asker({ tool: 'run_ssh', command: 'x', reason: 'r' }), true, 'approved answer must resolve true');
  clearTimeout(approve);
  assert.strictEqual(existsSync(join(box, 'ask.json')), false, 'ask.json must be cleaned after an answer');
  const deny = setTimeout(() => writeFileSync(join(box, 'answer.json'), JSON.stringify({ approved: false })), 40);
  assert.strictEqual(await asker({ tool: 'run_ssh', command: 'x', reason: 'r' }), false);
  clearTimeout(deny);
  // stale answer from a previous ask must not auto-approve: fresh ask, no reply -> timeout = deny
  writeFileSync(join(box, 'answer.json'), JSON.stringify({ approved: true }));
  const t0 = Date.now();
  assert.strictEqual(await makeMailboxAsker(box, { pollIntervalMs: 10, approveTimeoutMs: 120 })({ tool: 'run_ssh', command: 'y', reason: 'r' }), false, 'stale answer must be cleared, not trusted');
  assert.ok(Date.now() - t0 >= 100, 'timeout path must actually wait');

  // --- 7) Memory store: hub + spokes roundtrip via the writer/reader tools ---
  const mem = require('./dist/lib/memory');
  const dir = mem.agentMemoryDir('smoke-test');
  const wt = Object.fromEntries(mem.writeMemoryTools('smoke-test').map((t) => [t.name, t]));
  const rt = mem.readMemoryTools('smoke-test')[0];
  rmSync(dir, { recursive: true, force: true });
  assert.strictEqual(mem.readMemoryHub('smoke-test'), null, 'fresh agent has no hub');
  await wt.write_spoke.run({ spoke: 'hosts', content: '# Hosts\n- waszawa: nginx box\n' });
  await wt.write_index.run({ content: '- hosts.md — managed hosts\n' });
  assert.strictEqual(mem.readMemoryHub('smoke-test'), '- hosts.md — managed hosts\n');
  const got = await rt.run({ spoke: 'hosts' });
  assert.strictEqual(got.ok, true);
  assert.ok(got.output.includes('waszawa'));
  const missing = await rt.run({ spoke: 'nope' });
  assert.strictEqual(missing.ok, false);
  assert.ok(missing.output.includes('hosts.md'), 'missing-spoke error must list available files');
  await wt.write_spoke.run({ spoke: 'hosts', content: '  ' }); // empty content deletes
  assert.strictEqual(existsSync(join(dir, 'hosts.md')), false, 'empty content must delete the spoke');
  rmSync(dir, { recursive: true, force: true });

  // --- 8) Per-agent model plumbing: task.json carries the agent.json model ---
  const { readTask, writeResult } = require('./dist/lib/task');
  const tbox = mkdtempSync(join(tmpdir(), 'taskbox-'));
  writeFileSync(join(tbox, 'task.json'), JSON.stringify({ id: 't1', to: 'vision', task: 'look', model: 'deepseek-v4-flash-vision-exp' }, null, 2));
  assert.deepStrictEqual(readTask(tbox), { id: 't1', to: 'vision', task: 'look', model: 'deepseek-v4-flash-vision-exp' });
  const plain = mkdtempSync(join(tmpdir(), 'taskbox-'));
  writeFileSync(join(plain, 'task.json'), JSON.stringify({ id: 't2', task: 'x' }, null, 2));
  assert.strictEqual(readTask(plain).model, undefined, 'absent model must stay absent');
  writeResult(tbox, { id: 't1', from: 'vision', ok: true, output: 'y', log: [] });
  assert.strictEqual(JSON.parse(readFileSync(join(tbox, 'result.json'), 'utf8')).ok, true);

  // --- 9) Tool output serialization: text stays a string; images become content parts ---
  const { toolOutputParts } = require('./dist/lib/react');
  assert.strictEqual(toolOutputParts({ ok: true, output: 'x' }), 'x');
  assert.strictEqual(toolOutputParts({ ok: false, output: 'boom' }), 'ERROR: boom');
  assert.deepStrictEqual(toolOutputParts({ ok: true, output: 'sent', image: { url: 'data:image/png;base64,QQ==', detail: 'low' } }), [
    { type: 'input_text', text: 'sent' },
    { type: 'input_image', image_url: 'data:image/png;base64,QQ==', detail: 'low' },
  ]);
  assert.deepStrictEqual(toolOutputParts({ ok: true, output: '', image: { url: 'data:image/jpeg;base64,QQ==' } }), [
    { type: 'input_image', image_url: 'data:image/jpeg;base64,QQ==' },
  ]);

  // --- 10) view_image: magic-byte sniffing + a real file roundtrip (no API) ---
  const { viewImage, detectImageMime } = require('./dist/tools/view-image');
  assert.strictEqual(detectImageMime(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0])), 'image/png');
  assert.strictEqual(detectImageMime(Buffer.from('RIFF\x00\x00\x00\x00WEBPVP8 ', 'binary')), 'image/webp');
  assert.strictEqual(detectImageMime(Buffer.from('not an image')), null);
  const idir = mkdtempSync(join(tmpdir(), 'img-'));
  const pngPath = join(idir, 'shot.png');
  writeFileSync(pngPath, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]));
  const vi = await viewImage.run({ path: pngPath });
  assert.strictEqual(vi.ok, true);
  assert.ok(vi.image, 'image result must carry an image ref');
  assert.ok(vi.image.url.startsWith('data:image/png;base64,'), 'png must come back as a base64 data-url');
  writeFileSync(join(idir, 'x.txt'), 'plain text');
  const txt = await viewImage.run({ path: join(idir, 'x.txt') });
  assert.strictEqual(txt.ok, false);
  assert.ok(txt.output.includes('not a supported image'));
  const gone = await viewImage.run({ path: join(idir, 'nope.png') });
  assert.strictEqual(gone.ok, false);
  assert.ok(gone.output.includes('Cannot read'));
  rmSync(idir, { recursive: true, force: true });

  // --- 11) Short-term memory: transcript roundtrip + last-conversation pointer ---
  const stm = require('./dist/lib/stm');
  assert.strictEqual(stm.isValidConvId('a.b-c_d'), true);
  assert.strictEqual(stm.isValidConvId('../evil'), false, 'conv ids must not traverse paths');
  const conv = 'smoke' + Date.now();
  const convRoot = join(__dirname, 'memory', 'conversations');
  const priorLast = stm.lastConvId();
  stm.appendTurn(conv, { sid: 's1', q: 'which hosts run nginx?', output: 'warszawa' });
  stm.appendTurn(conv, { sid: 's2', q: 'check disk', output: '12% used' });
  const ctx = stm.recentContext(conv, 10);
  assert.strictEqual(ctx.count, 2);
  assert.ok(ctx.block.includes('warszawa') && ctx.block.includes('check disk'), 'context must carry both turns');
  const capped = stm.recentContext(conv, 1);
  assert.strictEqual(capped.count, 1);
  assert.ok(capped.block.includes('check disk') && !capped.block.includes('warszawa'), 'k cap must keep the newest turns');
  assert.strictEqual(stm.recentContext('no-such-conv').block, '', 'missing transcript must yield an empty block');
  stm.rememberLast(conv);
  assert.strictEqual(stm.lastConvId(), conv, 'last pointer must roundtrip');
  rmSync(join(convRoot, conv), { recursive: true, force: true });
  if (priorLast) stm.rememberLast(priorLast); else rmSync(join(convRoot, 'last.txt'), { force: true });

  console.log(`smoke ok — core silent, ${orch.agents.length} sub-agents registered`);
  console.log(`  agents: ${orch.agents.map((a) => `${a.name}${a.hasMemory ? ' (memory)' : ''}`).join(', ')}`);
})().catch((e) => { console.error(e); process.exit(1); });
