// SSH hosts the run_ssh tool can manage. Secrets never live here: each value
// names an env var that holds the real credential (export WARSZAWA-SMALL-*).
const env = (name: string) => process.env[name] ?? '';

export type SshHost = { name: string; host: string; user: string; pass: string, port: string };

export const sshHosts: SshHost[] = [
  {
    name: 'warszawa',
    host: env('WARSZAWA-SMALL-HOST'),
    user: env('WARSZAWA-SMALL-USER'),
    pass: env('WARSZAWA-SMALL-PASS'),
    port: env('WARSZAWA-SMALL-PORT'),
  },
    {
    name: 'cats',
    host: env('CAT-HOST'),
    user: env('CAT-HOST-USER'),
    pass: env('CAT-HOST-PASS'),
    port: env('CAT-HOST-PORT'),
  },
];
