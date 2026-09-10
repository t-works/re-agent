// run_command tool: run a shell command on this local machine. Executes via
// git-bash when one is installed (the model writes bash syntax; routing it
// through cmd /c mangles quotes, heredocs and unix paths), else falls back to
// the platform shell (cmd on Windows). The shell is picked once at load.
import { exec, execFile } from 'child_process';
import { existsSync } from 'fs';
import type { Tool } from '../lib/react';

// bin\bash.exe (the git wrapper, sets up PATH) preferred over usr\bin\bash.exe.
const BASH_CANDIDATES = [
  process.env.GIT_BASH,
  'C:\\Program Files\\Git\\bin\\bash.exe',
  'C:\\Program Files\\Git\\usr\\bin\\bash.exe',
  'C:\\Program Files (x86)\\Git\\bin\\bash.exe',
  ...(process.env.LOCALAPPDATA ? [`${process.env.LOCALAPPDATA}\\Programs\\Git\\bin\\bash.exe`] : []),
];
const bash = BASH_CANDIDATES.find((p) => p && existsSync(p)) ?? null;

export const runCommand: Tool = {
  name: 'run_command',
  description:
    "Run a shell command on this local machine (git-bash; bash syntax — unix-style paths like /j/ai/... and pipes/quotes/heredocs work). Use it for anything on this machine: filesystem, running programs, facts you don't know.",
  parameters: {
    type: 'object',
    properties: { command: { type: 'string', description: 'the exact shell command to run' } },
    required: ['command'],
  },
  run: (args) =>
    new Promise((resolve) => {
      const command = String(args.command ?? '');
      const done = (err: Error | null, stdout: string, stderr: string) => {
        // execFile reports the failure with the command echoed in err.message;
        // prefer the shell's own stderr (the actual error text).
        if (err) resolve({ ok: false, output: (stderr || err.message).trim() });
        else resolve({ ok: true, output: stdout.trim() });
      };
      // execFile + argv (no shell layer): bash syntax reaches bash untouched.
      if (bash) execFile(bash, ['-c', command], { timeout: 30000, windowsHide: true }, done);
      else exec(command, { timeout: 30000, windowsHide: true }, done);
    }),
};
