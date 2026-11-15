import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { ApprovalPolicy, executeTool, TOOLS } from '../src/tools/registry.js';
import { checkFile, detectNeverExiting, verifyChanges } from '../src/tools/verify.js';
import { Workspace } from '../src/tools/workspace.js';
import { tmpDir } from './helpers.js';

const hasPython = (() => {
  try {
    return require('node:child_process').spawnSync('python', ['--version']).status === 0;
  } catch {
    return false;
  }
})();

describe('verify', () => {
  it('syntax-checks JavaScript and JSON', async () => {
    const root = tmpDir();
    fs.writeFileSync(path.join(root, 'ok.js'), 'const a = 1;\n');
    fs.writeFileSync(path.join(root, 'bad.js'), 'const a = ;\n');
    fs.writeFileSync(path.join(root, 'bad.json'), '{"a": }');
    expect((await checkFile(path.join(root, 'ok.js'), 'ok.js', root))!.ok).toBe(true);
    expect((await checkFile(path.join(root, 'bad.js'), 'bad.js', root))!.ok).toBe(false);
    expect((await checkFile(path.join(root, 'bad.json'), 'bad.json', root))!.ok).toBe(false);
    expect(await checkFile(path.join(root, 'ok.js'), 'ok.js', root)).toMatchObject({ checker: 'node --check' });
  });

  it.runIf(hasPython)('syntax-checks Python without executing it', async () => {
    const root = tmpDir();
    const ws = new Workspace(root);
    ws.snapshot(path.join(ws.root, 'calc.py'));
    fs.writeFileSync(path.join(root, 'calc.py'), 'import tkinter as tk\ndef f(:\n    pass\n');
    const report = await verifyChanges(ws);
    expect(report.ok).toBe(false);
    expect(report.checks[0]!.message).toMatch(/SyntaxError|invalid syntax/);
    fs.writeFileSync(path.join(root, 'calc.py'), 'import sys\nsys.exit(5)\n');
    expect((await verifyChanges(ws)).ok).toBe(true); // compiled, not run
    expect(fs.existsSync(path.join(root, '__pycache__'))).toBe(false); // no bytecode left in the project
  });

  it('refuses to launch GUI programs (they never exit) and syntax-checks them instead', async () => {
    const root = tmpDir();
    const ws = new Workspace(root);
    fs.writeFileSync(path.join(root, 'app.py'), 'import tkinter as tk\nroot = tk.Tk()\nroot.mainloop()\n');
    fs.writeFileSync(path.join(root, 'cli.py'), 'print(1 + 1)\n');
    expect(detectNeverExiting('python app.py', ws)?.why).toMatch(/GUI/);
    expect(detectNeverExiting('python cli.py', ws)).toBeUndefined();
    expect(detectNeverExiting('python -m pytest', ws)).toBeUndefined();
    const res = await executeTool(
      'run_command',
      { command: 'python app.py' },
      { workspace: ws, config: loadConfig(), policy: new ApprovalPolicy(false), requestApproval: async () => 'no' },
      TOOLS.map((t) => t.name),
    );
    expect(res.output).toMatch(/Not run/);
    expect(res.summary).toMatch(/not run/);
  });
});
