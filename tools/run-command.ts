// run_command tool: run a shell command on this local machine via cmd/sh.
import { exec } from 'child_process';
import type { Tool } from '../lib/react';

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
