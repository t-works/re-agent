// Minimal ReAct agent loop + CLI. Run: npm run build && node dist/agent.js
import { exec } from 'child_process';
import { readFileSync } from 'fs';
import { join } from 'path';
import { createInterface } from 'readline';
import cfg from './config';

if (!cfg.apiKey) { console.error('Set DEEPSEEK_API_KEY first.'); process.exit(1); }

const systemPrompt = readFileSync(join(__dirname, '..', 'system.txt'), 'utf8');

type Message = { role: 'system' | 'user' | 'assistant'; content: string };

async function askLLM(messages: Message[]): Promise<string> {
  const res = await fetch(cfg.baseURL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` },
    body: JSON.stringify({ model: cfg.model, messages, temperature: 0 }),
  });
  if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);
  return (await res.json()).choices[0].message.content;
}

function runTool(actionInput: string): Promise<{ ok: boolean; output: string }> { // returns { ok, output }
  return new Promise((resolve) => {
    exec(actionInput, { timeout: 30000 }, (err, stdout, stderr) => {
      if (err) resolve({ ok: false, output: (stderr || err.message).trim() });
      else resolve({ ok: true, output: stdout.trim() });
    });
  });
}

async function runQuestion(question: string): Promise<string> {
  const messages: Message[] = [{ role: 'system', content: systemPrompt }, { role: 'user', content: question }];
  for (let i = 0; i < cfg.maxIterations; i++) {
    const reply = await askLLM(messages);
    console.log('\n' + reply + '\n' + '-'.repeat(60));
    const final = reply.match(/Final Answer:\s*([\s\S]*)/);
    if (final) return final[1].trim();

    const action = reply.match(/Action:\s*(\w+)/);
    const input = reply.match(/Action Input:\s*([\s\S]*)/);
    if (!action || !input) return 'Model stopped without a Final Answer.';
    if (action[1] !== 'run_command') return `Unknown action: ${action[1]}`;

    messages.push({ role: 'assistant', content: reply });
    const { ok, output } = await runTool(input[1].trim());
    console.log(`Observation: ${ok ? 'ok' : 'ERROR'}: ${output || '(empty)'}`);
    messages.push({ role: 'user', content: `Observation: ${ok ? output : 'ERROR: ' + output}` });
  }
  return 'Max iterations reached.';
}

const rl = createInterface({ input: process.stdin, output: process.stdout });
let closed = false;
rl.on('close', () => { closed = true; });
const prompt = () => rl.question('\nYou: ', async (q) => {
  if (['quit', 'exit', 'q'].includes(q.trim().toLowerCase())) { rl.close(); return; }
  try { console.log('\nAgent: ' + await runQuestion(q)); } catch (e) { console.error('Error:', (e as Error).message); }
  if (!closed) prompt();
});
console.log('ReAct agent. Ask anything (q = quit).');
prompt();
