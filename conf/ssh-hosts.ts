// SSH hosts the run_ssh tool can manage. Secrets never live here: each value
// names an env var that holds the real credential (export WARSZAWA-SMALL-*).
const env = (name: string) => process.env[name] ?? '';

export type SshHost = { name: string; host: string; user: string; pass: string };

export const sshHosts: SshHost[] = [
  {
    name: 'waszawa',
    host: env('WARSZAWA-SMALL-HOST'),
    user: env('WARSZAWA-SMALL-USER'),
    pass: env('WARSZAWA-SMALL-PASS'),
  },
];
