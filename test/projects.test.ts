import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { isDegenerate } from '../src/agents/degenerate.js';
import type { LoomEvent } from '../src/agents/events.js';
import { loadConfig } from '../src/config.js';
import { createProjectDir, looksLikeNewProject, projectNameFor } from '../src/core/projects.js';
import { Session } from '../src/core/session.js';
import { pickRouterModel } from '../src/router/heuristics.js';
import { pathOutsideWorkspace } from '../src/tools/commandSafety.js';
import { liveFileProgress } from '../src/ui/liveFile.js';
import { FakeClient, model, roleOf, tmpDir } from './helpers.js';

const neverAsked = async () => {
  throw new Error('approval must not be requested inside a project folder');
};

/** A scripted team that writes the given files with the block format, then approves. */
function team(files: Record<string, string>, extraCoderReply?: string) {
  let coderTurn = 0;
  return new FakeClient([model('plain:7b', { capabilities: ['completion'] })], (req) => {
    const role = roleOf(req);
    if (role === 'planner') return { content: '{"needs_changes": true, "summary": "s", "steps": ["write the files"]}' };
    if (role === 'coder') {
      coderTurn++;
      if (coderTurn === 1) {
        return { content: Object.entries(files).map(([p, c]) => `<write_file path="${p}">\n${c}\n</write_file>`).join('\n') };
      }
      if (coderTurn === 2 && extraCoderReply) return { content: extraCoderReply };
      coderTurn = 0;
      return { content: 'Done.' };
    }
    return { content: '{"verdict": "approve", "issues": []}' };
  });
}

describe('project names', () => {
  it('derives a short folder name from the request', () => {
    expect(projectNameFor('make a calculator app in python using tkinter')).toBe('calculator-app');
    expect(projectNameFor('Please build me a simple Snake game with pygame')).toBe('snake-game');
    expect(projectNameFor('!!!')).toBe('project');
    expect(projectNameFor('create a con')).toBe('con-project');
  });
  it('adds (1), (2) … when the name is taken', () => {
    const root = tmpDir();
    expect(createProjectDir(root, 'todo-app').name).toBe('todo-app');
    expect(createProjectDir(root, 'todo-app').name).toBe('todo-app (1)');
    expect(createProjectDir(root, 'todo-app').name).toBe('todo-app (2)');
    expect(fs.readdirSync(root).sort()).toEqual(['todo-app', 'todo-app (1)', 'todo-app (2)']);
  });
  it('tells a new project from a change to the current one', () => {
    expect(looksLikeNewProject('make a calculator app in python')).toBe(true);
    expect(looksLikeNewProject('now build another game, tic tac toe')).toBe(true);
    expect(looksLikeNewProject('bro what is this. make the app')).toBe(false);
    expect(looksLikeNewProject('add a dark mode')).toBe(false);
    expect(looksLikeNewProject('create a new file for the helpers')).toBe(false);
  });
});

describe('project folders', () => {
  it('creates one folder per project, continues follow-ups in it and suffixes duplicates', async () => {
    const base = tmpDir();
    const projectsRoot = path.join(base, 'LocalLoom Projects');
    const client = team({ 'src/main.py': 'print("hi")' });
    const session = new Session({ client, config: loadConfig(), cwd: base, projectsRoot });
    expect(fs.existsSync(projectsRoot)).toBe(true);
    const events: LoomEvent[] = [];
    const emit = (e: LoomEvent) => events.push(e);

    await session.runTask('make a calculator app in python', emit, neverAsked);
    const first = path.join(fs.realpathSync(projectsRoot), 'calculator-app');
    expect(fs.readFileSync(path.join(first, 'src/main.py'), 'utf8')).toBe('print("hi")\n');
    expect(session.workspace.root).toBe(first);
    expect(events.some((e) => e.type === 'notice' && /New project/.test(e.text))).toBe(true);

    // A follow-up stays in the same folder (the file exists, so the rewrite is refused and nothing new appears).
    await session.runTask('make the buttons bigger', emit, neverAsked);
    expect(fs.readdirSync(projectsRoot)).toEqual(['calculator-app']);

    // The same request again is a new project with the same name.
    await session.runTask('make a calculator app in python', emit, neverAsked);
    expect(fs.readdirSync(projectsRoot).sort()).toEqual(['calculator-app', 'calculator-app (1)']);
    expect(fs.existsSync(path.join(projectsRoot, 'calculator-app (1)', 'src/main.py'))).toBe(true);

    // /new forces a new folder even for a request that reads like a follow-up.
    session.newProject();
    await session.runTask('todo list', emit, neverAsked);
    expect(fs.readdirSync(projectsRoot)).toContain('todo-list');
  });

  it('lets agents delete and create folders freely inside the project, but not reach outside it', async () => {
    const base = tmpDir();
    fs.writeFileSync(path.join(base, 'secret.txt'), 'keep out');
    const calls = [
      { name: 'create_dir', arguments: { path: 'assets/img' } },
      { name: 'delete_file', arguments: { path: 'old.txt' } },
      { name: 'read_file', arguments: { path: '../../secret.txt' } },
      { name: 'write_file', arguments: { path: path.join(base, 'escaped.txt'), content: 'x' } },
      { name: 'run_command', arguments: { command: 'type ..\\..\\secret.txt' } },
    ];
    const client = team({ 'old.txt': 'old' }, JSON.stringify(calls));
    const session = new Session({ client, config: loadConfig({ autoApprove: true }), cwd: base, projectsRoot: path.join(base, 'LocalLoom Projects') });
    const events: LoomEvent[] = [];
    await session.runTask('make a notes tool', (e) => events.push(e), neverAsked);
    const dir = session.workspace.root;
    expect(path.basename(dir)).toBe('notes-tool');
    expect(fs.statSync(path.join(dir, 'assets/img')).isDirectory()).toBe(true);
    expect(fs.existsSync(path.join(dir, 'old.txt'))).toBe(false);
    expect(fs.existsSync(path.join(base, 'escaped.txt'))).toBe(false);
    const ends = events.filter((e): e is Extract<LoomEvent, { type: 'tool:end' }> => e.type === 'tool:end');
    const result = (name: string) => ends.find((e) => e.name === name)!;
    expect(result('create_dir').ok).toBe(true);
    expect(result('delete_file').ok).toBe(true);
    expect(result('read_file').ok).toBe(false);
    expect(ends.filter((e) => e.name === 'write_file').at(-1)!.ok).toBe(false);
    expect(result('run_command').summary).toMatch(/outside the project/);
  });

  it('does not keep a folder for a request that was only a question', async () => {
    const base = tmpDir();
    const projectsRoot = path.join(base, 'LocalLoom Projects');
    const client = new FakeClient([model('plain:7b')], () => ({ content: 'Python is a language.\n{"needs_changes": false, "summary": "answered"}' }));
    const session = new Session({ client, config: loadConfig(), cwd: base, projectsRoot });
    await session.runTask('what is python?', () => {}, neverAsked);
    expect(fs.readdirSync(projectsRoot)).toEqual([]);
    expect(session.project).toBeUndefined();
  });
});

describe('staying inside the project', () => {
  it('finds command arguments that point outside', () => {
    const root = 'C:\\work\\LocalLoom Projects\\app';
    const out = (cmd: string) => pathOutsideWorkspace(cmd, root, 'win32');
    expect(out('python main.py')).toBeUndefined();
    expect(out('dir /s src')).toBeUndefined();
    expect(out('pip install -r requirements.txt')).toBeUndefined();
    expect(out('python src\\..\\main.py')).toBeUndefined();
    expect(out('C:\\Python312\\python.exe main.py')).toBeUndefined();
    expect(out('type ..\\other\\notes.txt')).toBe('..\\other\\notes.txt');
    expect(out('cd .. && dir')).toBe('..');
    expect(out('del "C:\\Users\\me\\file.txt"')).toBe('C:\\Users\\me\\file.txt');
    expect(out('copy main.py %USERPROFILE%\\Desktop')).toBe('%USERPROFILE%\\Desktop');
    expect(pathOutsideWorkspace('cat /etc/passwd', '/home/me/app', 'linux')).toBe('/etc/passwd');
    expect(pathOutsideWorkspace('ls /home/me/app/src > /dev/null', '/home/me/app', 'linux')).toBeUndefined();
    expect(pathOutsideWorkspace('rm ~/notes', '/home/me/app', 'linux')).toBe('~/notes');
  });
});

describe('router model', () => {
  it('is always the smallest installed chat model', () => {
    const models = [
      model('deepseek-coder-v2:16b', { paramsB: 15.7, sizeBytes: 8.9e9 }),
      model('qwen2.5-coder:7b'),
      model('qwen2.5-coder:1.5b', { paramsB: 1.5, sizeBytes: 986e6 }),
      model('tiny:0.5b', { paramsB: 0.5, sizeBytes: 400e6 }),
    ];
    expect(pickRouterModel(models.slice(0, 3)).name).toBe('qwen2.5-coder:1.5b');
    expect(pickRouterModel(models).name).toBe('tiny:0.5b');
  });
});

describe('live file progress', () => {
  it('follows a write_file block while it streams', () => {
    const p = liveFileProgress('I will create it.\n<write_file path="src/main.py">\nimport tkinter as tk\n\nroot = tk.Tk()')!;
    expect(p).toMatchObject({ action: 'writing', path: 'src/main.py', lines: 3, complete: false });
    expect(p.content).toContain('root = tk.Tk()');
    expect(liveFileProgress('<write_file path="a.py">\nx = 1\n</write_file>')).toMatchObject({ lines: 1, complete: true });
  });
  it('follows edit blocks and JSON tool calls', () => {
    expect(liveFileProgress('<edit_file path="app.py" lines="12-15">\n<new>\na = 1\nb = 2')).toMatchObject({
      action: 'editing',
      path: 'app.py',
      range: '12-15',
      lines: 2,
    });
    const json = liveFileProgress('{"name": "write_file", "arguments": {"path": "x.js", "content": "const a = \\"1\\";\\nconsole.log(a);\\n');
    expect(json).toMatchObject({ action: 'writing', path: 'x.js', lines: 2, complete: false });
    expect(json!.content).toBe('const a = "1";\nconsole.log(a);\n');
    expect(liveFileProgress('Let me think about the plan first.')).toBeUndefined();
  });
});

describe('runaway output', () => {
  it('recognises output that collapsed into repetition, but not real code', () => {
    expect(isDegenerate('@'.repeat(700))).toBe(true);
    expect(isDegenerate('"path": "src tats", '.repeat(60))).toBe(true);
    expect(isDegenerate(`{"name": "edit_file", ${'"path": "src tats many", tats, "path": "path tats", many 绝大多数 tats, '.repeat(40)}`)).toBe(true);
    expect(isDegenerate(fs.readFileSync(new URL('../src/agents/runner.ts', import.meta.url), 'utf8'))).toBe(false);
    expect(isDegenerate(fs.readFileSync(new URL('../README.md', import.meta.url), 'utf8'))).toBe(false);
  });

  it('ends an agent turn instead of retrying garbled replies forever', async () => {
    const base = tmpDir();
    let coderCalls = 0;
    const client = new FakeClient([model('plain:7b', { capabilities: ['completion'] })], (req) => {
      const role = roleOf(req);
      if (role === 'planner') return { content: '{"needs_changes": true, "summary": "s", "steps": ["x"]}' };
      if (role === 'coder') {
        coderCalls++;
        return { content: `{"name": "write_file", ${'"path": "src tats", '.repeat(80)}` };
      }
      return { content: role === 'reviewer' ? '{"verdict": "approve", "issues": []}' : 'nothing to fix' };
    });
    const session = new Session({ client, config: loadConfig({ maxReviewCycles: 1 }), cwd: base });
    const events: LoomEvent[] = [];
    await session.runTask('create a.txt', (e) => events.push(e), neverAsked);
    expect(coderCalls).toBe(3);
    expect(events.some((e) => e.type === 'notice' && /garbled, repetitive output/.test(e.text))).toBe(true);
    expect((events.at(-1) as { status: string }).status).toBe('done');
  });

  it('ends a turn that keeps flipping a file between the same two versions', async () => {
    const base = tmpDir();
    fs.writeFileSync(path.join(base, 'app.py'), 'x = 1\n');
    let coderCalls = 0;
    const client = new FakeClient([model('plain:7b', { capabilities: ['completion'] })], (req) => {
      const role = roleOf(req);
      if (role === 'planner') return { content: '{"needs_changes": true, "summary": "s", "steps": ["x"]}' };
      if (role === 'coder') {
        coderCalls++;
        const value = coderCalls % 2 ? 2 : 1;
        return { content: `<edit_file path="app.py" lines="1"><new>x = ${value}</new></edit_file>` };
      }
      return { content: role === 'reviewer' ? '{"verdict": "approve", "issues": []}' : 'ok' };
    });
    const session = new Session({ client, config: loadConfig({ maxReviewCycles: 1 }), cwd: base });
    const events: LoomEvent[] = [];
    await session.runTask('change x in app.py', (e) => events.push(e), neverAsked);
    expect(coderCalls).toBeLessThanOrEqual(6);
    expect(events.some((e) => e.type === 'notice' && /back and forth/.test(e.text))).toBe(true);
  });
});
