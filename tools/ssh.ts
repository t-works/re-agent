// run_ssh tool: run shell commands over SSH on the hosts configured in
// conf/ssh-hosts.ts. A plain orchestrator tool (no sub-agent needed) — shared
// so any future sub-agent can register it too.
import { spawn } from 'child_process';
import type { Tool } from '../lib/react';
import { sshHosts, type SshHost } from '../conf/ssh-hosts';

/** Run one command on host h via plink, resolving {ok, output} instead of throwing. */
function runPlink(h: SshHost, cmd: string): Promise<{ ok: boolean; output: string }> {
  return new Promise((resolve) => {
    const child = spawn('plink', ['-ssh', '-l', h.user, '-pw', h.pass, h.host, cmd]);
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

const ADD_HOST_PROMPT = "To add a host to this tool add host data to conf/ssh-hosts.ts and restart the app." ;
/**
 * Build the run_ssh tool from hosts with full credentials. Single host -> a
 * {command} arg; multiple hosts -> an explicit host arg. Returns undefined when
 * no hosts are configured, so callers can omit the tool entirely.
 */
export function makeRunSshTool(): Tool | undefined {
  const hosts = sshHosts.filter((h) => h.host && h.user && h.pass);
  if (!hosts.length) return undefined;
  const single = hosts.length === 1;
  return {
    name: 'run_ssh',
    description: single
      ? `Run a shell command over SSH on the remote host '${hosts[0].name}' (${hosts[0].host}). ${ADD_HOST_PROMPT}`
      : `Run a shell command over SSH on a remote host. Hosts: ${hosts
          .map((h) => `${h.name} (${h.host})`)
          .join(', ')}. Pass the host name to pick one. ${ADD_HOST_PROMPT}`,
    parameters: {
      type: 'object',
      properties: {
        ...(single
          ? {}
          : { host: { type: 'string', description: `one of: ${hosts.map((h) => h.name).join(', ')}` } }),
        command: { type: 'string', description: 'the exact remote shell command to run' },
      },
      required: single ? ['command'] : ['host', 'command'],
    },
    run: async (args) => {
      const command = String(args.command ?? '').trim();
      if (!command) return { ok: false, output: 'run_ssh needs a command' };
      const host = single ? hosts[0] : hosts.find((h) => h.name === String(args.host ?? ''));
      if (!host) return { ok: false, output: `Unknown host. Known: ${hosts.map((h) => h.name).join(', ')}` };
      return runPlink(host, command);
    },
  };
}
