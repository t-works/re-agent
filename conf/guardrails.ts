// Command guardrail policy shared by run_command and run_ssh (see lib/guard.ts).
// Edit freely: rules are evaluated first-match, in order — put hard denies before
// asks. RegExp flags: do NOT use /g (stateful lastIndex breaks matching).
// tool: optional scope ('run_command' | 'run_ssh'); omit = applies to both.
export type GuardAction = 'deny' | 'ask';
export type GuardRule = { action: GuardAction; pattern: RegExp; reason: string; tool?: 'run_command' | 'run_ssh' };

export default {
  // Hard denies — auto-blocked, no human prompt, no execution. The nuke family.
  rules: [
    // rm -rf on root or a top-level dir
    { action: 'deny', pattern: /rm\s+-\S*rf\S*\s+(\/|\/\*|~\/?\s*$)/i, reason: 'recursive forced delete of a root/home path' },
    { action: 'deny', pattern: /\bdd\b[^|&;]*of=\/dev\/(sd|hd|vd|nvme|mmc)/i, reason: 'dd writing directly to a block device' },
    { action: 'deny', pattern: /\bmkfs(\.[a-z0-9]+)?\s+\/dev\//i, reason: 'filesystem creation on a block device' },
    { action: 'deny', pattern: /:\(\)\s*\{\s*:\|:&\s*\}/, reason: 'fork bomb' },
    { action: 'deny', pattern: /chmod\s+-R\s+[0-7]{3,4}\s+\//i, reason: 'recursive permission change from filesystem root' },
    { action: 'deny', pattern: /chown\s+-R[^|&;]*\s+\//i, reason: 'recursive ownership change from filesystem root' },
    { action: 'deny', pattern: /\b(rd|rmdir)\s+\/s\s+\/q\b/i, reason: 'Windows recursive forced directory delete' },
    { action: 'deny', pattern: /\bformat\s+[a-z]:/i, reason: 'disk format' },
    { action: 'deny', pattern: /\bgit\s+push\s+(-f|--force)\b/, reason: 'force-push rewrites remote history' },

    // Ask-before-run — anything here pauses for human approval before executing.
    // Scoped to run_ssh: remote hosts are where "server configuration" lives.
    // The local machine (Windows dev box) stays unrestricted by design.
    { action: 'ask', tool: 'run_ssh', pattern: /\bsystemctl\s+(start|stop|restart|reload|enable|disable|mask|unmask)\b/, reason: 'service state change' },
    { action: 'ask', tool: 'run_ssh', pattern: /\bservice\s+\S+\s+(start|stop|restart|reload)\b/, reason: 'service state change' },
    { action: 'ask', tool: 'run_ssh', pattern: /\b(reboot|shutdown|poweroff|halt)\b/, reason: 'host power state change' },
    { action: 'ask', tool: 'run_ssh', pattern: /\bsed\s+-i\b|\bperl\s+-pi?\b/, reason: 'in-place file edit' },
    { action: 'ask', tool: 'run_ssh', pattern: /\s(>|>>)\s+\/etc\/|\btee\b[^|&;]*\s+\/etc\//, reason: 'write into /etc' },
    { action: 'ask', tool: 'run_ssh', pattern: /\b(mv|cp|rm)\s+[^|&;]*\/etc\//, reason: 'file operation under /etc' },
    { action: 'ask', tool: 'run_ssh', pattern: /\b(apt-get|apt|yum|dnf|apk|zypper)\s+(install|remove|purge|erase|update|upgrade|dist-upgrade|autoremove)\b/, reason: 'package manager operation' },
    { action: 'ask', tool: 'run_ssh', pattern: /\b(chown|chmod|usermod|useradd|userdel|adduser|deluser|groupadd|groupdel|passwd)\b/, reason: 'user or permission change' },
    { action: 'ask', tool: 'run_ssh', pattern: /\b(?:ln|link|unlink)\s+-s[^|&;]*\/(etc|usr\/lib\/systemd)\//, reason: 'symlink change under system dirs' },
    { action: 'ask', tool: 'run_ssh', pattern: /\b(crontab|at)\b/, reason: 'scheduled task change' },
  ],
  // How long the config agent waits for a human answer before treating an ask as denied.
  approveTimeoutMs: 5 * 60 * 1000,
  // Mailbox polling cadence (child polls for the answer; orchestrator polls for the ask).
  pollIntervalMs: 300,
};
