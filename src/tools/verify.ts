import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { Workspace } from './workspace.js';

export interface FileCheck {
  path: string;
  ok: boolean;
  /** Tool used, e.g. "python -m py_compile". */
  checker: string;
  message: string;
}

export interface VerifyReport {
  checks: FileCheck[];
  ok: boolean;
}

function run(cmd: string, args: string[], cwd: string, timeoutMs = 30000): Promise<{ code: number | null; output: string; missing: boolean }> {
  return new Promise((resolve) => {
    let output = '';
    let settled = false;
    const done = (r: { code: number | null; output: string; missing: boolean }) => {
      if (settled) return;
      settled = true;
      resolve(r);
    };
    let child;
    try {
      child = spawn(cmd, args, { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } });
    } catch {
      return done({ code: null, output: '', missing: true });
    }
    child.stdout?.on('data', (d: Buffer) => (output += d.toString()));
    child.stderr?.on('data', (d: Buffer) => (output += d.toString()));
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.on('error', (err: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      done({ code: null, output: err.message, missing: err.code === 'ENOENT' });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      // The Windows "python" app-execution alias prints a Store hint and exits 9009 when Python is absent.
      const missing = code === 9009 || /Microsoft Store|was not found; run without arguments/i.test(output);
      done({ code, output: output.trim(), missing });
    });
  });
}

let pythonCmd: string[] | null | undefined;

/** Find a working Python interpreter (cached). */
async function findPython(cwd: string): Promise<string[] | null> {
  if (pythonCmd !== undefined) return pythonCmd;
  const candidates = process.platform === 'win32' ? [['python'], ['py', '-3'], ['python3']] : [['python3'], ['python']];
  for (const c of candidates) {
    const r = await run(c[0]!, [...c.slice(1), '--version'], cwd, 10000);
    if (!r.missing && r.code === 0) return (pythonCmd = c);
  }
  return (pythonCmd = null);
}

/** Python compile errors mention the temp path; keep the useful part short. */
function trimPythonError(out: string, rel: string): string {
  const lines = out.split(/\r?\n/).filter((l) => l.trim());
  // Keep only the innermost frame (the user's file), not the checker's own wrapper frame.
  let start = 0;
  lines.forEach((l, i) => {
    if (/^\s*File "/.test(l)) start = i;
  });
  return lines
    .slice(start)
    .join('\n')
    .replace(/File "[^"]*"/, `File "${rel}"`)
    .slice(0, 1200);
}

/**
 * Syntax-check one file without executing it. Returns undefined for file types we can't check.
 */
export async function checkFile(abs: string, rel: string, cwd: string): Promise<FileCheck | undefined> {
  const ext = path.extname(abs).toLowerCase();
  if (!fs.existsSync(abs)) return undefined;
  if (ext === '.py') {
    const py = await findPython(cwd);
    if (!py) return undefined;
    // compile() checks syntax in memory: nothing is executed and no __pycache__ is written into the project.
    const script = 'import sys\np = sys.argv[1]\nsrc = open(p, encoding="utf-8").read()\ncompile(src, p, "exec")';
    const r = await run(py[0]!, [...py.slice(1), '-c', script, abs], cwd);
    return { path: rel, ok: r.code === 0, checker: 'python compile', message: r.code === 0 ? 'syntax OK' : trimPythonError(r.output, rel) };
  }
  if (ext === '.js' || ext === '.mjs' || ext === '.cjs') {
    const r = await run(process.execPath, ['--check', abs], cwd);
    return { path: rel, ok: r.code === 0, checker: 'node --check', message: r.code === 0 ? 'syntax OK' : r.output.slice(0, 1200) };
  }
  if (ext === '.json') {
    try {
      JSON.parse(fs.readFileSync(abs, 'utf8'));
      return { path: rel, ok: true, checker: 'JSON.parse', message: 'valid JSON' };
    } catch (err) {
      return { path: rel, ok: false, checker: 'JSON.parse', message: (err as Error).message };
    }
  }
  return undefined;
}

/** Syntax-check every created/modified file of the current task. */
export async function verifyChanges(workspace: Workspace): Promise<VerifyReport> {
  const checks: FileCheck[] = [];
  for (const change of workspace.changedFiles()) {
    if (change.status === 'deleted') continue;
    const abs = path.join(workspace.root, change.path);
    const check = await checkFile(abs, change.path, workspace.root);
    if (check) checks.push(check);
  }
  return { checks, ok: checks.every((c) => c.ok) };
}

export function formatReport(report: VerifyReport): string {
  if (!report.checks.length) return '(no automatic checks available for the changed files)';
  return report.checks.map((c) => `- ${c.path}: ${c.ok ? 'PASS' : 'FAIL'} (${c.checker})${c.ok ? '' : `\n${c.message.replace(/^/gm, '    ')}`}`).join('\n');
}

const NEVER_EXITS = [
  { re: /\bmainloop\s*\(|\bimport\s+tkinter|\bfrom\s+tkinter\b|\bPyQt[56]?\b|\bPySide[26]?\b|\bimport\s+wx\b|\bkivy\b/, why: 'it opens a GUI window' },
  { re: /\bimport\s+pygame\b|\bpygame\.display\b/, why: 'it opens a game window' },
  { re: /\bapp\.run\s*\(|\buvicorn\.run\s*\(|\bserve_forever\s*\(|\.listen\s*\(\s*\d+/, why: 'it starts a server' },
  { re: /\binput\s*\(|\breadline\s*\(|process\.stdin/, why: 'it waits for keyboard input' },
];

/**
 * Detect `python app.py` / `node app.js` for programs that never exit on their own (GUI, server,
 * interactive). Running them would hang until the timeout.
 */
export function detectNeverExiting(command: string, workspace: Workspace): { file: string; why: string } | undefined {
  const m = /^\s*(?:python3?|py(?:\s+-3)?|node)\s+(?:-u\s+)?["']?([^\s"']+\.(?:py|js|mjs|cjs))["']?\s*$/i.exec(command);
  if (!m) return undefined;
  let abs: string;
  try {
    abs = workspace.resolve(m[1]!);
  } catch {
    return undefined;
  }
  if (!fs.existsSync(abs)) return undefined;
  const src = fs.readFileSync(abs, 'utf8');
  for (const { re, why } of NEVER_EXITS) if (re.test(src)) return { file: workspace.relative(abs), why };
  return undefined;
}
