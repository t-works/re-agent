// SSH sub-agent: runs a ReAct loop whose only tool is run_ssh — plink to the
// host(s) configured in this dir's *.host.json (each value names an env var).
// Spawned by the orchestrator with the mailbox dir as argv[2].
import { spawn } from 'child_process';
import { readFileSync, readdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import cfg from '../config';
import { reactLoop, printLoopEvent } from '../lib/react';
import type { Tool } from '../lib/react';

if (!cfg.apiKey) { console.error('Set DEEPSEEK_API_KEY first.'); process.exit(1); }

const SRC_ROOT = join(__dirname, '..', '..'); // dist/SSH-AGENT -> project root

type Host = { name: string; host: string; user: string; password: string };

/** Load SSH-AGENT/*.host.json host configs; each value names an env var holding the real secret. */
function loadHosts(): Host[] {
  const dir = join(SRC_ROOT, 'SSH-AGENT');
  return readdirSync(dir)
    .filter((f) => f.endsWith('.host.json'))
    .map((f) => {
      const c = JSON.parse(readFileSync(join(dir, f), 'utf8')) as Record<string, string>;
      const envOf = (v: string) => process.env[v] ?? '';
      return { name: f.replace(/\.host\.json$/, ''), host: envOf(c.host), user: envOf(c.user), password: envOf(c.pass) };
    });
}

/** Run one command on host h via plink, resolving {ok, output} instead of throwing. */
function runPlink(h: Host, cmd: string): Promise<{ ok: boolean; output: string }> {
  return new Promise((resolve) => {
    const child = spawn('plink', ['-ssh', '-l', h.user, '-pw', h.password, h.host, cmd]);
    // 'y\n' answers plink's "store host key?" prompt on first contact; ignored afterwards.
    child.stdin.write('y\n');
    let out = '', err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    // ponytail: fixed 30s per command, spawnWithTimeout-style tuning if hosts need more
    const timer = setTimeout(() => { child.kill(); resolve({ ok: false, output: 'ssh timed out after 30s' }); }, 30000);
    child.on('error', (e) => { clearTimeout(timer); resolve({ ok: false, output: e.message }); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve({ ok: true, output: out.trim() });
      else resolve({ ok: false, output: (err || out).trim() || `plink exited ${code}` });
    });
  });
}

/** Build the run_ssh tool: single host -> plain command; multiple hosts -> first token picks the host. */
function runSsh(hosts: Host[]): Tool {
  return {
    name: 'run_ssh',
    run: async (input: string) => {
      if (hosts.length === 1) return runPlink(hosts[0], input.trim());
      const [name, ...rest] = input.trim().split(/\s+/);
      const host = hosts.find((h) => h.name === name);
      if (!host) return { ok: false, output: `Unknown host. Known: ${hosts.map((h) => h.name).join(', ')}. Prefix the command with the host name.` };
      return runPlink(host, rest.join(' '));
    },
  };
}

/** Entry point (spawned by the orchestrator with a mailbox dir): run the ReAct loop and write result.json. */
async function main() {
  const workDir = process.argv[2];
  if (!workDir) { console.error('Usage: node agent.js <workDir containing task.json>'); process.exit(1); }
  const task = JSON.parse(readFileSync(join(workDir, 'task.json'), 'utf8')) as { id: string; task: string };

  const hosts = loadHosts();
  if (!hosts.length) { console.error('No *.host.json in SSH-AGENT/'); process.exit(1); }
  const missing = hosts.filter((h) => !h.host || !h.user || !h.password);
  if (missing.length) {
    console.error(`Missing env vars for host(s): ${missing.map((h) => h.name).join(', ')} (see *.host.json for var names)`);
    process.exit(1);
  }

  const systemPrompt = readFileSync(join(SRC_ROOT, 'SSH-AGENT', 'system.txt'), 'utf8');
  const result = await reactLoop({ systemPrompt, task: task.task, tools: [runSsh(hosts)], onEvent: printLoopEvent });
  writeFileSync(
    join(workDir, 'result.json'),
    JSON.stringify({ id: task.id, from: 'ssh', ok: result.ok, output: result.output, log: result.log }, null, 2)
  );
  process.exit(result.ok ? 0 : 1);
}

main();
