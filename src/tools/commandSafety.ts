/**
 * Classification of shell commands requested by agents.
 *  - blocked:  never executed (destructive / system-level / remote-code patterns)
 *  - safe:     read-only commands that run without confirmation
 *  - approval: everything else; the user must confirm
 */
export type CommandRisk = 'blocked' | 'safe' | 'approval';

export interface CommandAssessment {
  risk: CommandRisk;
  reason: string;
}

const BLOCKED: { pattern: RegExp; reason: string }[] = [
  { pattern: /\brm\s+(-[a-z]*\s+)*-[a-z]*[rf][a-z]*\s+(-[a-z]+\s+)*(\/|~|\*|\.\.?)(\s|$|\/\*?(\s|$))/i, reason: 'recursive delete of root, home, parent or everything' },
  { pattern: /\brm\s+.*--no-preserve-root/i, reason: 'rm --no-preserve-root' },
  { pattern: /:\(\)\s*\{\s*:\|:&\s*\};:/, reason: 'fork bomb' },
  { pattern: /\bmkfs(\.\w+)?\b/i, reason: 'filesystem formatting' },
  { pattern: /\bdd\s+.*\bof=\/dev\//i, reason: 'raw disk write' },
  { pattern: />\s*\/dev\/(sd|nvme|hd|disk)/i, reason: 'raw disk write' },
  { pattern: /\bformat(\.com)?\s+[a-z]:/i, reason: 'drive formatting' },
  { pattern: /\bdiskpart\b/i, reason: 'disk partitioning' },
  { pattern: /\b(shutdown|reboot|halt|poweroff)\b/i, reason: 'system power control' },
  { pattern: /\b(Stop-Computer|Restart-Computer)\b/i, reason: 'system power control' },
  { pattern: /\b(del|erase)\s+.*\/s\b.*\b[a-z]:\\?(\s|$|\*)/i, reason: 'recursive delete of a drive root' },
  { pattern: /\b(rd|rmdir)\s+.*\/s\b.*\b[a-z]:\\?(\s|$)/i, reason: 'recursive delete of a drive root' },
  { pattern: /\bRemove-Item\b.*-Recurse.*\s[a-z]:\\?(\s|$|\*)/i, reason: 'recursive delete of a drive root' },
  { pattern: /\b(curl|wget)\b[^|]*\|\s*(sudo\s+)?(ba|z|da)?sh\b/i, reason: 'piping a remote script into a shell' },
  { pattern: /\b(iwr|irm|Invoke-WebRequest|Invoke-RestMethod)\b.*\|\s*(iex|Invoke-Expression)\b/i, reason: 'executing a remote script' },
  { pattern: /\bsudo\b|\bsu\s+-?\s*$|\brunas\b/i, reason: 'privilege escalation' },
  { pattern: /\bchmod\s+(-R\s+)?[0-7]*777\s+\/(\s|$)/i, reason: 'chmod 777 on root' },
  { pattern: /\bchown\s+-R\s+.*\s\/(\s|$)/i, reason: 'recursive chown of root' },
  { pattern: /\breg(\.exe)?\s+(delete|add)\b/i, reason: 'Windows registry modification' },
  { pattern: /\bgit\s+push\b.*(--force|-f\b|--mirror)/i, reason: 'force push' },
  { pattern: /\bgit\s+clean\s+.*-[a-z]*f[a-z]*x/i, reason: 'git clean -x deletes ignored files' },
  { pattern: /\bnpm\s+(publish|unpublish)\b/i, reason: 'publishing packages' },
  { pattern: /\b(bcdedit|vssadmin|cipher\s+\/w)\b/i, reason: 'system-level Windows tool' },
  { pattern: /\b(setx|Set-ExecutionPolicy)\b/i, reason: 'persistent system configuration' },
  { pattern: /\bcrontab\s+-r\b/i, reason: 'removing crontab' },
];

/** First-word commands considered read-only. */
const SAFE_COMMANDS = new Set([
  'ls', 'dir', 'pwd', 'cat', 'type', 'head', 'tail', 'wc', 'tree', 'echo', 'where', 'which',
  'grep', 'rg', 'findstr', 'stat', 'file', 'du', 'whoami', 'date', 'uname', 'ver', 'hostname',
]);

const SAFE_PREFIXES: RegExp[] = [
  /^git\s+(status|diff|log|show|branch|remote\s+-v|rev-parse|ls-files|blame|describe|tag\s*$)\b/i,
  /^(node|npm|npx|pnpm|yarn|python|python3|py|pip|go|cargo|rustc|java|javac|dotnet|tsc|deno|bun)\s+(-v|--version|-V|version)\s*$/i,
  /^npm\s+(ls|list|outdated|view|config\s+get)\b/i,
  /^pip\s+(list|show|freeze)\b/i,
];

/** Shell metacharacters that could chain, redirect or substitute commands. */
const CHAINING = /[;&|><`]|\$\(/;

export function assessCommand(command: string): CommandAssessment {
  const cmd = command.trim();
  if (!cmd) return { risk: 'blocked', reason: 'empty command' };
  for (const { pattern, reason } of BLOCKED) {
    if (pattern.test(cmd)) return { risk: 'blocked', reason };
  }
  if (!CHAINING.test(cmd)) {
    const first = cmd.split(/\s+/)[0]!.toLowerCase().replace(/\.exe$/, '');
    if (SAFE_COMMANDS.has(first)) {
      // `find` with -delete/-exec is not read-only; grep etc. are fine.
      return { risk: 'safe', reason: 'read-only command' };
    }
    if (first === 'find' && !/-(delete|exec|execdir|ok)\b/.test(cmd)) return { risk: 'safe', reason: 'read-only command' };
    if (SAFE_PREFIXES.some((p) => p.test(cmd))) return { risk: 'safe', reason: 'read-only command' };
  }
  return { risk: 'approval', reason: 'may modify the system or execute project code' };
}
