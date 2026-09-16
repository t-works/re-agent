// Smoke check for the interface/core split: run `npm run build && node smoke.js`
// 1) reactLoop speaks the Responses API wire format and emits events without
//    printing on its own. 2) createOrchestrator builds without a terminal.
// 3) The tool round-trip and the unknown-tool recovery path work.
const assert = require('assert');
const { mkdtempSync, rmSync } = require('fs');
const { join: pjoin } = require('path');
const { tmpdir } = require('os');
// Smoke gets its own throwaway STATE_ROOT so it never reads or wipes a real
// project's memory/ or runtime agents. Must be set before the core modules
// load — lib/roots.ts resolves STATE_ROOT at import time.
const smokeState = mkdtempSync(pjoin(tmpdir(), 'react-smoke-state-'));
process.env.REACT_STATE_DIR = smokeState;
const roots = require('./dist/lib/roots');
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

  // 3b) Reasoning echo + call batching: with thinking enabled, a follow-up
  // request must carry the response's reasoning item back verbatim AND list all
  // function_calls before any function_call_output — DeepSeek 400s on both
  // omissions (interleaved call/output pairs fail too).
  const reasoningItem = {
    type: 'reasoning', id: 'rs_1', status: 'completed',
    content: [{ type: 'reasoning_text', text: 'think think' }], summary: [], encrypted_content: 'xyz',
  };
  const reasonBodies = [
    resp(reasoningItem, fnCall('c1', 'echo', '{"input":"a"}'), fnCall('c2', 'echo', '{"input":"b"}')),
    resp(msg('thought done')),
  ];
  let bn = 0;
  const reqs = [];
  global.fetch = async (_url, init) => {
    reqs.push(JSON.parse(init.body));
    const body = reasonBodies[bn++];
    assert.ok(body, 'fetch called more than expected');
    return { ok: true, json: async () => body };
  };
  const r3b = await reactLoop({ systemPrompt: 's', task: 't', tools: [echoTool] });
  assert.strictEqual(r3b.output, 'thought done');
  assert.deepStrictEqual(reqs[0].input, [{ role: 'user', content: 't' }], 'first request must start clean');
  const in2 = reqs[1].input;
  const echoed = in2.filter((it) => it.type === 'reasoning');
  assert.strictEqual(echoed.length, 1, 'second request must echo the reasoning item');
  assert.strictEqual(echoed[0].id, 'rs_1');
  assert.strictEqual(echoed[0].content[0].text, 'think think', 'reasoning must ride back verbatim');
  const kinds = in2.map((it) => it.type);
  const fcs = kinds.filter((k) => k === 'function_call').length;
  const fcos = kinds.filter((k) => k === 'function_call_output').length;
  assert.strictEqual(fcs, 2);
  assert.strictEqual(fcos, 2);
  const lastCall = kinds.lastIndexOf('function_call');
  const firstOut = kinds.indexOf('function_call_output');
  assert.ok(firstOut > lastCall, 'all function_calls must precede all function_call_outputs');

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
  const { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } = require('fs');
  const { tmpdir } = require('os');
  const { join, isAbsolute } = require('path');
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
  const convRoot = join(roots.STATE_ROOT, 'memory', 'conversations');
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
  // Interrupted turns: the question is logged at turn START (output ''), and
  // updateLastTurn patches that line with the final answer or error on completion.
  const convInt = 'smokeint' + Date.now();
  stm.appendTurn(convInt, { sid: 's9', q: 'long build?', output: '' }); // crashed before finishing
  const intCtx = stm.recentContext(convInt, 10);
  assert.strictEqual(intCtx.count, 1);
  assert.ok(intCtx.block.includes('(interrupted'), 'unfinished turn must render as interrupted on resume');
  stm.updateLastTurn(convInt, { output: 'ERROR: API 400' });
  assert.ok(stm.recentContext(convInt, 10).block.includes('API 400'), 'patched output must replace the interrupted marker');
  stm.appendTurn(convInt, { sid: 's10', q: 'retry?', output: '' });
  stm.updateLastTurn(convInt, { output: 'scaffolded' });
  const intTurns = stm.readTurns(convInt);
  assert.strictEqual(intTurns.length, 2, 'patch must not add or drop transcript lines');
  assert.strictEqual(intTurns[1].output, 'scaffolded');
  assert.strictEqual(intTurns[0].output, 'ERROR: API 400');
  stm.updateLastTurn('no-such-conv', { output: 'x' }); // must be a safe no-op
  rmSync(join(convRoot, convInt), { recursive: true, force: true });
  stm.rememberLast(conv);
  assert.strictEqual(stm.lastConvId(), conv, 'last pointer must roundtrip');
  rmSync(join(convRoot, conv), { recursive: true, force: true });
  if (priorLast) stm.rememberLast(priorLast); else rmSync(join(convRoot, 'last.txt'), { force: true });

  // --- 12) Workspace artifact tools: roundtrip, subdirs, escape rejection ---
  const { makeArtifactTools } = require('./dist/tools/artifact');
  const wsDir = mkdtempSync(join(tmpdir(), 'ws-'));
  const art = Object.fromEntries(makeArtifactTools(wsDir).map((t) => [t.name, t]));
  assert.ok(art.write_artifact && art.read_artifact, 'workspace must expose write_artifact + read_artifact');
  const aw1 = await art.write_artifact.run({ path: 'step1/report.md', content: '# done\n- ok' });
  assert.strictEqual(aw1.ok, true);
  assert.ok(aw1.output.includes('step1/report.md'));
  const ar1 = await art.read_artifact.run({ path: 'step1/report.md' });
  assert.strictEqual(ar1.ok, true);
  assert.ok(ar1.output.includes('done'), 'roundtrip content must match');
  const esc1 = await art.read_artifact.run({ path: '../secret.txt' });
  assert.strictEqual(esc1.ok, false);
  assert.ok(esc1.output.includes('workspace'), '.. escape must be rejected');
  assert.strictEqual((await art.read_artifact.run({ path: '/etc/hosts' })).ok, false, 'absolute paths must be rejected');
  assert.strictEqual((await art.write_artifact.run({ path: 'C:/evil.txt', content: 'x' })).ok, false, 'drive paths must be rejected');
  const miss = await art.read_artifact.run({ path: 'nope.md' });
  assert.strictEqual(miss.ok, false);
  assert.ok(miss.output.includes('step1/report.md'), 'missing-artifact error must list available files');
  const escW1 = await art.write_artifact.run({ path: '../../evil.txt', content: 'x' });
  assert.strictEqual(escW1.ok, false, 'write must reject escapes too');
  rmSync(wsDir, { recursive: true, force: true });

  // --- 13) Data-agent pool wiring: guardrailed commands, memory opt-in, no fabricated ssh ---
  const { buildAgentTools, POOL_NAMES } = require('./dist/tools/pool');
  assert.deepStrictEqual(POOL_NAMES, ['run_command', 'run_ssh', 'view_image', 'read_artifact', 'write_artifact']);
  const ws2 = mkdtempSync(join(tmpdir(), 'ws2-'));
  const pt = Object.fromEntries(
    buildAgentTools({ name: 't', tools: ['run_command', 'view_image', 'read_artifact', 'write_artifact'], workspace: ws2, ask: async () => true }).map((t) => [t.name, t])
  );
  assert.ok(pt.run_command && pt.view_image && pt.read_artifact && pt.write_artifact, 'requested pool tools must be built');
  const pden = await pt.run_command.run({ command: 'rm -rf /' });
  assert.strictEqual(pden.ok, false);
  assert.ok(pden.output.includes('DENIED'), 'pool command tools must be guardrailed');
  const withMem = Object.fromEntries(buildAgentTools({ name: 'tmem', tools: [], hasMemory: true, ask: async () => false }).map((t) => [t.name, t]));
  assert.ok(withMem.read_spoke, 'hasMemory must add read_spoke');
  const noSsh = buildAgentTools({ name: 'n', tools: ['run_ssh'], ask: async () => true });
  if (!process.env['WARSZAWA-SMALL-HOST'])
    assert.strictEqual(noSsh.length, 0, 'run_ssh requested without configured hosts must be omitted, not fabricated');
  rmSync(ws2, { recursive: true, force: true });

  // --- 14) create_agent spec validation (pure, offline) ---
  const { validateAgentSpec } = require('./dist/lib/orchestrator');
  assert.strictEqual(validateAgentSpec({ name: 'Bad Name', description: 'd', systemPrompt: 'p' }).ok, false, 'name charset must be enforced');
  assert.strictEqual(validateAgentSpec({ name: 'ok', description: '', systemPrompt: 'p' }).ok, false, 'description is required');
  assert.strictEqual(validateAgentSpec({ name: 'ok', description: 'd', systemPrompt: '' }).ok, false, 'systemPrompt is required');
  assert.strictEqual(validateAgentSpec({ name: 'ok', description: 'd', systemPrompt: 'p', tools: ['not_a_tool'] }).ok, false, 'tool subset must be enforced');
  assert.strictEqual(validateAgentSpec({ name: 'ok', description: 'd', systemPrompt: 'p', tools: ['read_spoke'] }).ok, false, 'memory tools are not pool tools (hasMemory adds them)');
  const goodSpec = validateAgentSpec({ name: 'analyst', description: 'reviews things', systemPrompt: 'You are analyst.', tools: ['read_artifact', 'write_artifact'], hasMemory: true, model: 'deepseek-v4-flash' });
  assert.strictEqual(goodSpec.ok, true);
  assert.deepStrictEqual(goodSpec.validated.json, { name: 'analyst', description: 'reviews things', tools: ['read_artifact', 'write_artifact'], hasMemory: true, model: 'deepseek-v4-flash' });
  const bareSpec = validateAgentSpec({ name: 'thinker', description: 'd', systemPrompt: 'p' });
  assert.strictEqual(bareSpec.ok, true);
  assert.deepStrictEqual(bareSpec.validated.json.tools, [], 'absent tools must default to []');

  // --- 15) runtime/agents registry: created agents register without a restart ---
  const runtimeRoot = join(roots.STATE_ROOT, 'runtime', 'agents');
  rmSync(runtimeRoot, { recursive: true, force: true }); // deterministic: no leftovers from crashed runs
  const rdir = join(runtimeRoot, 'smoke-runtime-agent');
  mkdirSync(rdir, { recursive: true });
  writeFileSync(join(rdir, 'agent.json'), JSON.stringify({ name: 'smoke-runtime-agent', description: 'runtime registry test', tools: ['read_artifact', 'write_artifact'] }, null, 2));
  writeFileSync(join(rdir, 'system.txt'), 'You are a smoke-test agent.');
  const orch2 = createOrchestrator();
  const rra = orch2.agents.find((a) => a.name === 'smoke-runtime-agent');
  assert.ok(rra, 'runtime/agents entries must appear in the registry');
  assert.strictEqual(rra.hasMemory, false);
  assert.ok(
    isAbsolute(rra.dir) && rra.dir.endsWith(join('runtime', 'agents', 'smoke-runtime-agent')),
    'runtime agents must expose an absolute source dir'
  );
  rmSync(rdir, { recursive: true, force: true });
  rmSync(runtimeRoot, { recursive: true, force: true });
  const orch3 = createOrchestrator();
  assert.ok(!orch3.agents.find((a) => a.name === 'smoke-runtime-agent'), 'removed runtime agents must drop out');

  // --- 16) Root resolution: code root separate from per-project state ---
  assert.strictEqual(roots.CODE_ROOT, __dirname, 'CODE_ROOT must be this install dir');
  assert.strictEqual(roots.WORK_ROOT, process.cwd(), 'WORK_ROOT must be the launch dir');
  assert.strictEqual(roots.STATE_ROOT, smokeState, 'explicit REACT_STATE_DIR pins state');
  const pA = mkdtempSync(join(tmpdir(), 'rootsA-'));
  mkdirSync(join(pA, '.react'), { recursive: true });
  mkdirSync(join(pA, 'memory'), { recursive: true });
  assert.strictEqual(roots.resolveStateRoot(pA, {}), join(pA, '.react'), '.react dir opts the project in, over legacy memory/');
  const pB = mkdtempSync(join(tmpdir(), 'rootsB-'));
  mkdirSync(join(pB, 'memory'), { recursive: true });
  assert.strictEqual(roots.resolveStateRoot(pB, {}), pB, 'existing memory/ keeps the legacy in-repo layout');
  const pC = mkdtempSync(join(tmpdir(), 'rootsC-'));
  const rHome = mkdtempSync(join(tmpdir(), 'rootho-'));
  const sC = roots.resolveStateRoot(pC, { REACT_HOME: rHome });
  assert.ok(sC.startsWith(join(rHome, 'projects')) && sC !== pC, 'a bare project gets isolated home state');
  assert.strictEqual(roots.resolveStateRoot(pC, { REACT_HOME: rHome }), sC, 'state dir must be stable for the same path');
  const pD = mkdtempSync(join(tmpdir(), 'rootsD-'));
  assert.notStrictEqual(roots.resolveStateRoot(pD, { REACT_HOME: rHome }), sC, 'different paths must not share state');
  for (const d of [pA, pB, pC, pD, rHome]) rmSync(d, { recursive: true, force: true });

  // --- 17) GitHub secret tools: sealed-box crypto, approval gate, no value leaks ---
  const ghsec = require('./dist/tools/github-secrets');
  const sodium = require('libsodium-wrappers');
  await sodium.ready; // libsodium-wrappers async init (same module the tool loads lazily)

  // repo parsing (https and scp forms) — used to default the target repo
  assert.strictEqual(ghsec.parseGithubRepo('https://github.com/t-works/re-agent.git'), 't-works/re-agent');
  assert.strictEqual(ghsec.parseGithubRepo('git@github.com:t-works/re-agent.git'), 't-works/re-agent');
  assert.strictEqual(ghsec.parseGithubRepo('https://gitlab.com/a/b.git'), '', 'non-github remotes have no github repo');
  assert.strictEqual(ghsec.normalizeRepo('https://github.com/o/r.git'), 'o/r');
  assert.strictEqual(ghsec.normalizeRepo('not a repo'), '', 'a malformed repo is rejected, not guessed');

  // what we hand GitHub must be a sealed box the scope private key can open
  const kp = sodium.crypto_box_keypair();
  const pkB64 = sodium.to_base64(kp.publicKey, sodium.base64_variants.ORIGINAL);
  const sealed = await ghsec.sealSecret('s3cret-value', pkB64);
  const opened = sodium.crypto_box_seal_open(
    sodium.from_base64(sealed, sodium.base64_variants.ORIGINAL), kp.publicKey, kp.privateKey
  );
  assert.strictEqual(sodium.to_string(opened), 's3cret-value', 'the sealed box must open with the box private key');
  assert.ok(!sealed.includes('s3cret-value'), 'the ciphertext must not contain the plaintext');

  const ghCalls = [];
  let putStatus = 201; // GitHub: 201 create, 204 update
  const ghFetch = async (url, init) => {
    const u = String(url);
    const method = (init && init.method) || 'GET';
    ghCalls.push({
      url: u, method,
      body: init && init.body ? JSON.parse(init.body) : undefined,
      auth: init && init.headers && init.headers.Authorization,
    });
    if (method === 'GET' && u.endsWith('/public-key'))
      return { ok: true, status: 200, text: async () => JSON.stringify({ key_id: 'kid-1', key: pkB64 }) };
    if (method === 'GET')
      return { ok: true, status: 200, text: async () => JSON.stringify({ total_count: 1, secrets: [{ name: 'DEEPSEEK_API_KEY', updated_at: '2026-09-15T10:00:00Z' }] }) };
    return { ok: true, status: method === 'PUT' ? putStatus : 204, text: async () => '' };
  };

  const asks = [];
  let approved = true;
  const ghTools = Object.fromEntries(
    ghsec.makeGithubSecretsTools({
      token: 'tok', repo: 't-works/re-agent', fetchImpl: ghFetch,
      ask: async (q) => { asks.push(q); return approved; },
    }).map((t) => [t.name, t])
  );

  // a denied approval stops the write before any network call, and carries no value
  approved = false;
  const denied = await ghTools.set_github_secret.run({ name: 'NPM_TOKEN', value: 'npm-secret' });
  assert.strictEqual(denied.ok, false);
  assert.ok(denied.output.includes('DENIED'), 'a denied write must report DENIED');
  assert.strictEqual(ghCalls.length, 0, 'a denied write must not touch the network');
  assert.strictEqual(asks.length, 1, 'a write must ask exactly once');
  assert.ok(!JSON.stringify(asks).includes('npm-secret'), 'the approval prompt must never carry the value');
  assert.ok(asks[0].command.includes('set secret NPM_TOKEN on repo t-works/re-agent'), 'the prompt must name key and target');

  // malformed calls are rejected BEFORE the approval prompt — no wasted roundtrip
  approved = true;
  for (const [label, args] of [
    ['missing value', { name: 'FOO' }],
    ['ambiguous value', { name: 'FOO', value: 'a', from_env: 'PATH' }],
    ['empty value', { name: 'FOO', value: '' }],
    ['bad name', { name: '1BAD-NAME', value: 'a' }],
    ['reserved name', { name: 'GITHUB_TOKEN', value: 'a' }],
    ['unknown scope', { name: 'FOO', value: 'a', scope: 'nope' }],
    ['environment without a name', { name: 'FOO', value: 'a', scope: 'environment' }],
    ['org without an org', { name: 'FOO', value: 'a', scope: 'org' }],
  ]) {
    const before = asks.length;
    const r = await ghTools.set_github_secret.run(args);
    assert.strictEqual(r.ok, false, label + ' must fail');
    assert.strictEqual(asks.length, before, label + ' must not reach the approval prompt');
  }

  // approved write: the value comes from the process env, is sealed, and the PUT carries key_id
  process.env.SMOKE_GH_SECRET = 'env-value-42';
  const set1 = await ghTools.set_github_secret.run({ name: 'DEEPSEEK_API_KEY', from_env: 'SMOKE_GH_SECRET' });
  assert.strictEqual(set1.ok, true);
  assert.ok(set1.output.includes('created'), 'a 201 PUT is a create');
  assert.ok(!set1.output.includes('env-value-42'), 'the result must never echo the value');
  const put = ghCalls[ghCalls.length - 1];
  assert.strictEqual(put.method, 'PUT');
  assert.strictEqual(put.url, 'https://api.github.com/repos/t-works/re-agent/actions/secrets/DEEPSEEK_API_KEY');
  assert.strictEqual(put.body.key_id, 'kid-1', 'the PUT must echo the fetched key_id');
  assert.ok(put.auth.startsWith('Bearer '), 'the request must be authenticated');
  const roundTripped = sodium.to_string(
    sodium.crypto_box_seal_open(sodium.from_base64(put.body.encrypted_value, sodium.base64_variants.ORIGINAL), kp.publicKey, kp.privateKey)
  );
  assert.strictEqual(roundTripped, 'env-value-42', 'the PUT body must carry the sealed value');

  // from_file source, environment scope, and 204 → "updated"
  const secretFile = pjoin(smokeState, 'secret-value.txt');
  writeFileSync(secretFile, 'file-value\n');
  putStatus = 204;
  ghCalls.length = 0;
  const set2 = await ghTools.set_github_secret.run({ name: 'NPM_TOKEN', from_file: secretFile, scope: 'environment', environment: 'production' });
  assert.strictEqual(set2.ok, true);
  assert.ok(set2.output.includes('updated'), 'a 204 PUT is an update');
  assert.strictEqual(ghCalls[1].url, 'https://api.github.com/repos/t-works/re-agent/environments/production/secrets/NPM_TOKEN');
  const fileSealed = sodium.to_string(
    sodium.crypto_box_seal_open(sodium.from_base64(ghCalls[1].body.encrypted_value, sodium.base64_variants.ORIGINAL), kp.publicKey, kp.privateKey)
  );
  assert.strictEqual(fileSealed, 'file-value', 'the trailing newline of a value file must be dropped');

  // list is read-only (no approval), hits the org scope, and reports names only
  ghCalls.length = 0;
  const asksBeforeList = asks.length;
  const listed = await ghTools.list_github_secrets.run({ scope: 'org', org: 't-works' });
  assert.strictEqual(listed.ok, true);
  assert.strictEqual(asksBeforeList, asks.length, 'listing must not ask for approval');
  assert.strictEqual(ghCalls[0].url, 'https://api.github.com/orgs/t-works/actions/secrets?per_page=100');
  assert.ok(listed.output.includes('DEEPSEEK_API_KEY') && listed.output.includes('(updated 2026-09-15)'), 'list shows names + dates');

  // delete is gated too: denied = no call, approved = DELETE on the repo scope
  approved = false;
  ghCalls.length = 0;
  const delDenied = await ghTools.delete_github_secret.run({ name: 'NPM_TOKEN' });
  assert.strictEqual(delDenied.ok, false);
  assert.ok(delDenied.output.includes('DENIED'));
  assert.strictEqual(ghCalls.length, 0, 'a denied delete must not touch the network');
  approved = true;
  const del = await ghTools.delete_github_secret.run({ name: 'NPM_TOKEN' });
  assert.strictEqual(del.ok, true);
  assert.strictEqual(ghCalls[ghCalls.length - 1].method, 'DELETE');
  assert.strictEqual(ghCalls[ghCalls.length - 1].url, 'https://api.github.com/repos/t-works/re-agent/actions/secrets/NPM_TOKEN');

  // GitHub errors surface as ok:false with the reason — never an exception
  const failing = Object.fromEntries(
    ghsec.makeGithubSecretsTools({
      token: 'tok', repo: 't-works/re-agent', ask: async () => true,
      fetchImpl: async () => ({ ok: false, status: 403, text: async () => JSON.stringify({ message: 'Resource not accessible by personal access token' }) }),
    }).map((t) => [t.name, t])
  );
  const forbid = await failing.set_github_secret.run({ name: 'FOO', value: 'v' });
  assert.strictEqual(forbid.ok, false);
  assert.ok(forbid.output.includes('403') && forbid.output.includes('Secrets: write'), '403 must explain the missing permission');
  const broken = Object.fromEntries(
    ghsec.makeGithubSecretsTools({
      token: 'tok', repo: 't-works/re-agent', ask: async () => true,
      fetchImpl: async () => { throw new Error('ENOTFOUND api.github.com'); },
    }).map((t) => [t.name, t])
  );
  const offline = await broken.set_github_secret.run({ name: 'FOO', value: 'v' });
  assert.strictEqual(offline.ok, false);
  assert.ok(offline.output.includes('request to GitHub failed'), 'a network failure must be reported, not thrown');

  // no token in the environment: refuse locally with an actionable message, no network
  const savedTokens = { GITHUB_TOKEN: process.env.GITHUB_TOKEN, GH_TOKEN: process.env.GH_TOKEN };
  delete process.env.GITHUB_TOKEN;
  delete process.env.GH_TOKEN;
  const noToken = Object.fromEntries(
    ghsec.makeGithubSecretsTools({ repo: 't-works/re-agent', ask: async () => true, fetchImpl: ghFetch }).map((t) => [t.name, t])
  );
  ghCalls.length = 0;
  const noTok = await noToken.set_github_secret.run({ name: 'FOO', value: 'v' });
  assert.strictEqual(noTok.ok, false);
  assert.ok(noTok.output.includes('No GitHub token'), 'a missing token must be explained');
  assert.strictEqual(ghCalls.length, 0, 'no token = no network call');
  if (savedTokens.GITHUB_TOKEN === undefined) delete process.env.GITHUB_TOKEN; else process.env.GITHUB_TOKEN = savedTokens.GITHUB_TOKEN;
  if (savedTokens.GH_TOKEN === undefined) delete process.env.GH_TOKEN; else process.env.GH_TOKEN = savedTokens.GH_TOKEN;
  delete process.env.SMOKE_GH_SECRET;

  // the owning agent is registered, and secret writing stays out of the data-agent pool
  const secretsAgent = orch3.agents.find((a) => a.name === 'secrets-manager');
  assert.ok(secretsAgent, 'secrets-manager must be registered');
  assert.strictEqual(secretsAgent.hasMemory, false, 'secrets-manager needs no memory hub');
  assert.ok(!POOL_NAMES.includes('set_github_secret'), 'secret writing must not be a pool capability');

  rmSync(smokeState, { recursive: true, force: true }); // throwaway state, never a real project's

  console.log(`smoke ok — core silent, ${orch.agents.length} sub-agents registered`);
  console.log(`  agents: ${orch.agents.map((a) => `${a.name}${a.hasMemory ? ' (memory)' : ''}`).join(', ')}`);
})().catch((e) => { console.error(e); process.exit(1); });
