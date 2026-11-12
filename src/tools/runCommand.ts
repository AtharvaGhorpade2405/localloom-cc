import { spawn } from 'node:child_process';

export interface CommandResult {
  exitCode: number | null;
  output: string;
  timedOut: boolean;
  aborted: boolean;
}

const MAX_OUTPUT = 16000;

function truncateMiddle(s: string, max: number): string {
  if (s.length <= max) return s;
  const head = Math.floor(max * 0.4);
  const tail = max - head;
  return `${s.slice(0, head)}\n… [${s.length - max} characters omitted] …\n${s.slice(-tail)}`;
}

export function runShellCommand(
  command: string,
  opts: { cwd: string; timeoutSec: number; shell: string | true; signal?: AbortSignal },
): Promise<CommandResult> {
  return new Promise((resolve) => {
    let output = '';
    let timedOut = false;
    let aborted = false;
    const child = spawn(command, {
      cwd: opts.cwd,
      shell: opts.shell,
      windowsHide: true,
      env: { ...process.env, CI: '1', FORCE_COLOR: '0', NO_COLOR: '1', npm_config_yes: 'true' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const append = (d: Buffer) => {
      output += d.toString('utf8');
      if (output.length > MAX_OUTPUT * 4) output = truncateMiddle(output, MAX_OUTPUT * 2);
    };
    child.stdout?.on('data', append);
    child.stderr?.on('data', append);

    const kill = () => {
      if (child.exitCode !== null || child.killed) return;
      if (process.platform === 'win32' && child.pid) {
        // Kill the whole process tree on Windows.
        spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      } else {
        child.kill('SIGTERM');
        setTimeout(() => child.kill('SIGKILL'), 2000).unref();
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, opts.timeoutSec * 1000);
    const onAbort = () => {
      aborted = true;
      kill();
    };
    opts.signal?.addEventListener('abort', onAbort, { once: true });

    const finish = (exitCode: number | null) => {
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
      // Strip ANSI escape sequences.
      const clean = output.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
      resolve({ exitCode, output: truncateMiddle(clean.trim(), MAX_OUTPUT), timedOut, aborted });
    };
    child.on('error', (err) => {
      output += `\n${err.message}`;
      finish(null);
    });
    child.on('close', (code) => finish(code));
  });
}
