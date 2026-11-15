import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../src/config.js';
import { ApprovalPolicy, executeTool, TOOLS, toolSpecs, type ToolContext } from '../src/tools/registry.js';
import { Workspace } from '../src/tools/workspace.js';
import { tmpDir } from './helpers.js';

const ALL = TOOLS.map((t) => t.name);

function ctx(root: string, approval: 'yes' | 'no' | 'always' = 'yes'): ToolContext & { asked: ReturnType<typeof vi.fn> } {
  const asked = vi.fn(async () => approval);
  return {
    workspace: new Workspace(root),
    config: loadConfig(),
    policy: new ApprovalPolicy(false),
    requestApproval: asked,
    asked,
  };
}

describe('tools', () => {
  it('writes, reads, edits and lists files', async () => {
    const root = tmpDir();
    const c = ctx(root);
    const w = await executeTool('write_file', { path: 'src/hello.js', content: 'const a = 1;\nconsole.log(a);\n' }, c, ALL);
    expect(w.ok).toBe(true);
    expect(fs.readFileSync(path.join(root, 'src/hello.js'), 'utf8')).toContain('const a = 1;');

    const r = await executeTool('read_file', { path: 'src/hello.js' }, c, ALL);
    expect(r.ok).toBe(true);
    expect(r.output).toMatch(/1│ const a = 1;/);

    const e = await executeTool('edit_file', { path: 'src/hello.js', old_string: 'const a = 1;', new_string: 'const a = 2;' }, c, ALL);
    expect(e.ok).toBe(true);
    expect(fs.readFileSync(path.join(root, 'src/hello.js'), 'utf8')).toContain('const a = 2;');

    const l = await executeTool('list_dir', { path: '.' }, c, ALL);
    expect(l.output).toContain('src/');
    expect(l.output).toContain('hello.js');

    expect(c.workspace.changedFiles()).toEqual([{ path: 'src/hello.js', status: 'created' }]);
  });

  it('accepts common argument aliases from small models', async () => {
    const root = tmpDir();
    const c = ctx(root);
    const w = await executeTool('create_file', { file_path: 'x.txt', contents: 'hi' }, c, ALL);
    expect(w.ok).toBe(true);
    expect(fs.readFileSync(path.join(root, 'x.txt'), 'utf8')).toBe('hi');
  });

  it('reports helpful errors', async () => {
    const root = tmpDir();
    const c = ctx(root);
    fs.writeFileSync(path.join(root, 'a.txt'), 'x\nx\n');
    expect((await executeTool('read_file', { path: 'missing.txt' }, c, ALL)).output).toMatch(/not found/);
    expect((await executeTool('edit_file', { path: 'a.txt', old_string: 'zzz', new_string: 'y' }, c, ALL)).output).toMatch(/not found/);
    expect((await executeTool('edit_file', { path: 'a.txt', old_string: 'x', new_string: 'y' }, c, ALL)).output).toMatch(/matches 2/);
    expect((await executeTool('read_file', { path: '../etc/passwd' }, c, ALL)).output).toMatch(/outside/);
    expect((await executeTool('nope', {}, c, ALL)).output).toMatch(/Unknown tool/);
    expect((await executeTool('write_file', { path: 'a' }, c, ALL)).output).toMatch(/Invalid arguments/);
    expect((await executeTool('write_file', { path: 'a', content: '' }, c, ['read_file'])).output).toMatch(/not available/);
  });

  it('edit_file tolerates trailing whitespace and preserves CRLF', async () => {
    const root = tmpDir();
    const c = ctx(root);
    fs.writeFileSync(path.join(root, 'w.txt'), 'line one   \r\nline two\r\n');
    const e = await executeTool('edit_file', { path: 'w.txt', old_string: 'line one\nline two', new_string: 'A\nB' }, c, ALL);
    expect(e.ok).toBe(true);
    expect(fs.readFileSync(path.join(root, 'w.txt'), 'utf8')).toBe('A\r\nB\r\n');
  });

  it('searches code and finds files, skipping node_modules', async () => {
    const root = tmpDir();
    fs.mkdirSync(path.join(root, 'src'));
    fs.mkdirSync(path.join(root, 'node_modules/pkg'), { recursive: true });
    fs.writeFileSync(path.join(root, 'src/a.ts'), 'export function greet() {}\n');
    fs.writeFileSync(path.join(root, 'src/b.py'), 'def greet(): pass\n');
    fs.writeFileSync(path.join(root, 'node_modules/pkg/index.js'), 'function greet() {}\n');
    const c = ctx(root);
    const s = await executeTool('search_code', { pattern: 'greet' }, c, ALL);
    expect(s.output).toContain('src/a.ts:1');
    expect(s.output).toContain('src/b.py:1');
    expect(s.output).not.toContain('node_modules');
    const g = await executeTool('search_code', { pattern: 'greet', glob: '*.ts' }, c, ALL);
    expect(g.output).not.toContain('b.py');
    const f = await executeTool('find_files', { pattern: '*.py' }, c, ALL);
    expect(f.output.trim()).toBe('src/b.py');
  });

  it('asks before deleting files and honours denial', async () => {
    const root = tmpDir();
    fs.writeFileSync(path.join(root, 'd.txt'), 'x');
    const denied = ctx(root, 'no');
    const r = await executeTool('delete_file', { path: 'd.txt' }, denied, ALL);
    expect(r.ok).toBe(false);
    expect(denied.asked).toHaveBeenCalledOnce();
    expect(fs.existsSync(path.join(root, 'd.txt'))).toBe(true);
    const ok = ctx(root, 'yes');
    expect((await executeTool('delete_file', { path: 'd.txt' }, ok, ALL)).ok).toBe(true);
    expect(fs.existsSync(path.join(root, 'd.txt'))).toBe(false);
  });

  it('runs safe commands without approval, blocks dangerous ones, and asks for others', async () => {
    const root = tmpDir();
    const c = ctx(root, 'no');
    const safe = await executeTool('run_command', { command: 'echo hello' }, c, ALL);
    expect(safe.ok).toBe(true);
    expect(safe.output).toContain('hello');
    expect(c.asked).not.toHaveBeenCalled();

    const blocked = await executeTool('run_command', { command: 'rm -rf /' }, c, ALL);
    expect(blocked.ok).toBe(false);
    expect(blocked.output).toMatch(/blocked/);

    const denied = await executeTool('run_command', { command: 'node -e "console.log(1)"' }, c, ALL);
    expect(denied.ok).toBe(false);
    expect(denied.output).toMatch(/denied/);
    expect(c.asked).toHaveBeenCalledOnce();

    const always = ctx(root, 'always');
    const first = await executeTool('run_command', { command: 'node -e "console.log(41+1)"' }, always, ALL);
    expect(first.output).toContain('42');
    await executeTool('run_command', { command: 'node -e "console.log(41+1)"' }, always, ALL);
    expect(always.asked).toHaveBeenCalledOnce();
  });

  it('produces JSON schemas for Ollama tool calling', () => {
    const specs = toolSpecs(['read_file', 'write_file']);
    expect(specs).toHaveLength(2);
    const params = specs[0]!.function.parameters as { properties: Record<string, unknown>; required: string[] };
    expect(params.properties.path).toBeDefined();
    expect(params.required).toContain('path');
  });
});

describe('edit_file tolerance (small-model mistakes)', () => {
  const ALL_TOOLS = TOOLS.map((t) => t.name);
  const src = [
    'class Calc:',
    '    def __init__(self):',
    '        buttons = [',
    "            ('7', 1, 0), ('8', 1, 1),",
    "            ('4', 2, 0), ('5', 2, 1),",
    '        ]',
    '',
  ].join('\n');

  it('strips line-number prefixes copied from read_file output', async () => {
    const root = tmpDir();
    fs.writeFileSync(path.join(root, 'c.py'), src);
    const c = ctx(root);
    const r = await executeTool(
      'edit_file',
      { path: 'c.py', old_string: "4│             ('7', 1, 0), ('8', 1, 1),", new_string: "4│             ('7', 1, 0), ('8', 1, 1), ('.', 1, 2)," },
      c,
      ALL_TOOLS,
    );
    expect(r.ok).toBe(true);
    expect(fs.readFileSync(path.join(root, 'c.py'), 'utf8')).toContain("('8', 1, 1), ('.', 1, 2),");
  });

  it('matches ignoring indentation and re-indents the replacement', async () => {
    const root = tmpDir();
    fs.writeFileSync(path.join(root, 'c.py'), src);
    const c = ctx(root);
    const r = await executeTool(
      'edit_file',
      {
        path: 'c.py',
        old_string: "buttons = [\n    ('7', 1, 0), ('8', 1, 1),",
        new_string: "buttons = [\n    ('C', 0, 0),\n    ('7', 1, 0), ('8', 1, 1),",
      },
      c,
      ALL_TOOLS,
    );
    expect(r.ok).toBe(true);
    expect(r.output).toMatch(/re-indented/);
    expect(fs.readFileSync(path.join(root, 'c.py'), 'utf8')).toContain("        buttons = [\n            ('C', 0, 0),\n            ('7', 1, 0), ('8', 1, 1),\n            ('4', 2, 0)");
  });

  it('shows the closest real lines when the model retyped the code wrongly', async () => {
    const root = tmpDir();
    fs.writeFileSync(path.join(root, 'c.py'), src);
    const c = ctx(root);
    // Real failure from qwen2.5-coder:7b: quotes and commas dropped.
    const r = await executeTool('edit_file', { path: 'c.py', old_string: 'buttons = [\n(7, 1, 0), (8, 1, 1),\n(4, 2, 0), (5, 2, 1),\n]', new_string: 'x' }, c, ALL_TOOLS);
    expect(r.ok).toBe(false);
    expect(r.output).toContain("('7', 1, 0), ('8', 1, 1),");
    expect(r.output).toMatch(/do not retype code from memory/);
    expect(r.output).toMatch(/start_line=3, end_line=6/);
    expect(r.output).toMatch(/Do not rewrite the whole file/);
    expect(fs.readFileSync(path.join(root, 'c.py'), 'utf8')).toBe(src); // nothing was changed
  });
});

describe('edit in place, never rewrite existing files', () => {
  const ALL_TOOLS = TOOLS.map((t) => t.name);
  const src = ['line one', 'line two', 'line three', 'line four', ''].join('\n');

  it('refuses to overwrite a file that existed before the task', async () => {
    const root = tmpDir();
    fs.writeFileSync(path.join(root, 'a.py'), src);
    const c = ctx(root);
    const r = await executeTool('write_file', { path: 'a.py', content: 'everything replaced\n' }, c, ALL_TOOLS);
    expect(r.ok).toBe(false);
    expect(r.output).toMatch(/already exists.*NOT overwritten/s);
    expect(r.output).toMatch(/edit_file/);
    expect(fs.readFileSync(path.join(root, 'a.py'), 'utf8')).toBe(src);
  });

  it('still allows rewriting files created during this task, or when the user asked for a rewrite', async () => {
    const root = tmpDir();
    const c = ctx(root);
    expect((await executeTool('write_file', { path: 'new.py', content: 'v1\n' }, c, ALL_TOOLS)).ok).toBe(true);
    expect((await executeTool('write_file', { path: 'new.py', content: 'v2\n' }, c, ALL_TOOLS)).ok).toBe(true);
    fs.writeFileSync(path.join(root, 'old.py'), src);
    const allowed = { ...ctx(root), allowOverwrite: true };
    expect((await executeTool('write_file', { path: 'old.py', content: 'rewritten\n' }, allowed, ALL_TOOLS)).ok).toBe(true);
  });

  it('edits by line range and returns the updated region with current line numbers', async () => {
    const root = tmpDir();
    fs.writeFileSync(path.join(root, 'a.py'), src);
    const c = ctx(root);
    const r = await executeTool('edit_file', { path: 'a.py', start_line: 2, end_line: 3, new_string: 'TWO\nTWO-B\nTHREE' }, c, ALL_TOOLS);
    expect(r.ok).toBe(true);
    expect(fs.readFileSync(path.join(root, 'a.py'), 'utf8')).toBe('line one\nTWO\nTWO-B\nTHREE\nline four\n');
    expect(r.output).toContain('5│ line four');
    // insert without removing: end_line = start_line - 1
    const ins = await executeTool('edit_file', { path: 'a.py', start_line: 1, end_line: 0, new_string: '# header' }, c, ALL_TOOLS);
    expect(ins.ok).toBe(true);
    expect(fs.readFileSync(path.join(root, 'a.py'), 'utf8').startsWith('# header\nline one\n')).toBe(true);
  });

  it('rejects bad or stale line ranges without changing the file', async () => {
    const root = tmpDir();
    fs.writeFileSync(path.join(root, 'a.py'), src);
    const c = ctx(root);
    expect((await executeTool('edit_file', { path: 'a.py', start_line: 3, end_line: 9, new_string: 'x' }, c, ALL_TOOLS)).output).toMatch(/Invalid line range.*4 lines/);
    const stale = await executeTool('edit_file', { path: 'a.py', start_line: 1, end_line: 1, old_string: 'def totally_different_function():', new_string: 'x' }, c, ALL_TOOLS);
    expect(stale.output).toMatch(/stale/);
    expect(fs.readFileSync(path.join(root, 'a.py'), 'utf8')).toBe(src);
    expect((await executeTool('edit_file', { path: 'a.py', new_string: 'x' }, c, ALL_TOOLS)).output).toMatch(/start_line\/end_line or old_string/);
  });
});

describe('line-range edit safeguards', () => {
  const ALL_TOOLS = TOOLS.map((t) => t.name);

  it('restores indentation the model dropped', async () => {
    const root = tmpDir();
    fs.writeFileSync(path.join(root, 'c.py'), 'class A:\n    def f(self):\n        x = 1\n        return x\n');
    const c = ctx(root);
    const r = await executeTool('edit_file', { path: 'c.py', start_line: 3, end_line: 3, new_string: 'x = 2\ny = 3' }, c, ALL_TOOLS);
    expect(r.output).toMatch(/indentation was restored/);
    expect(fs.readFileSync(path.join(root, 'c.py'), 'utf8')).toBe('class A:\n    def f(self):\n        x = 2\n        y = 3\n        return x\n');
  });

  it('warns immediately when an edit breaks the syntax', async () => {
    const root = tmpDir();
    fs.writeFileSync(path.join(root, 'a.js'), 'const a = 1;\nconst b = 2;\n');
    const c = ctx(root);
    const r = await executeTool('edit_file', { path: 'a.js', start_line: 2, end_line: 2, new_string: 'const b = ;' }, c, ALL_TOOLS);
    expect(r.ok).toBe(true);
    expect(r.output).toMatch(/WARNING: after this edit the file has a syntax error/);
    expect(r.summary).toMatch(/syntax error/);
  });
});
