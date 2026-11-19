import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ToolCall } from '../src/ollama/types.js';
import { loadConfig } from '../src/config.js';
import { buildCheckpoint, captureBaseline, undoCheckpoint } from '../src/core/checkpoints.js';
import { Session } from '../src/core/session.js';
import { parseCommand } from '../src/ui/commands.js';
import { FakeClient, model, roleOf, tmpDir } from './helpers.js';

const write = (root: string, rel: string, content: string) => {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), content);
};
const read = (root: string, rel: string) => fs.readFileSync(path.join(root, rel), 'utf8');
const exists = (root: string, rel: string) => fs.existsSync(path.join(root, rel));

describe('checkpoints', () => {
  it('reverts modified, created and deleted files and new folders, leaving ignored folders alone', () => {
    const root = fs.realpathSync(tmpDir());
    write(root, 'a.txt', 'one');
    write(root, 'gone.txt', 'keep me');
    write(root, 'node_modules/pkg/index.js', 'old');
    fs.mkdirSync(path.join(root, 'empty-before'));
    const baseline = captureBaseline(root);
    expect(baseline.complete).toBe(true);

    write(root, 'a.txt', 'two');
    fs.rmSync(path.join(root, 'gone.txt'));
    write(root, 'src/deep/new.js', 'x');
    fs.writeFileSync(path.join(root, 'bin.dat'), Buffer.from([0, 1, 2, 255]));
    write(root, 'node_modules/pkg/index.js', 'new');

    const cp = buildCheckpoint(baseline, [], 'task')!;
    expect(cp.changes.map((c) => c.path)).toEqual(['a.txt', 'bin.dat', 'gone.txt', 'src/deep/new.js']);
    expect(cp.newDirs).toEqual(['src/deep', 'src']);

    const out = undoCheckpoint(cp);
    expect(out.applied).toBe(true);
    expect(read(root, 'a.txt')).toBe('one');
    expect(read(root, 'gone.txt')).toBe('keep me');
    expect(exists(root, 'bin.dat')).toBe(false);
    expect(exists(root, 'src')).toBe(false);
    expect(exists(root, 'empty-before')).toBe(true);
    expect(read(root, 'node_modules/pkg/index.js')).toBe('new');
  });

  it('returns nothing when the request changed nothing', () => {
    const root = fs.realpathSync(tmpDir());
    write(root, 'a.txt', 'one');
    expect(buildCheckpoint(captureBaseline(root), [], 'task')).toBeUndefined();
  });

  it('refuses to overwrite later edits unless forced', () => {
    const root = fs.realpathSync(tmpDir());
    write(root, 'a.txt', 'one');
    const baseline = captureBaseline(root);
    write(root, 'a.txt', 'agent');
    const cp = buildCheckpoint(baseline, [], 't')!;
    write(root, 'a.txt', 'user edit');
    const refused = undoCheckpoint(cp);
    expect(refused).toMatchObject({ applied: false, conflicts: ['a.txt'] });
    expect(read(root, 'a.txt')).toBe('user edit');
    expect(undoCheckpoint(cp, { force: true }).applied).toBe(true);
    expect(read(root, 'a.txt')).toBe('one');
  });

  it('falls back to the file tools’ records when the folder is too large to copy', () => {
    const root = fs.realpathSync(tmpDir());
    write(root, 'a.txt', 'one');
    write(root, 'b.txt', 'two');
    fs.mkdirSync(path.join(root, 'old-empty'));
    const baseline = captureBaseline(root, { maxFiles: 1 });
    expect(baseline.complete).toBe(false);
    write(root, 'a.txt', 'changed by a tool');
    write(root, 'b.txt', 'changed by a command');
    write(root, 'tool-new.txt', 'new');
    const cp = buildCheckpoint(baseline, [['a.txt', 'one'], ['tool-new.txt', null]], 't')!;
    expect(cp.complete).toBe(false);
    expect(cp.changes.map((c) => c.path)).toEqual(['a.txt', 'tool-new.txt']);
    expect(cp.newDirs).toEqual([]);
    undoCheckpoint(cp);
    expect(read(root, 'a.txt')).toBe('one');
    expect(exists(root, 'tool-new.txt')).toBe(false);
    expect(read(root, 'b.txt')).toBe('changed by a command');
    expect(exists(root, 'old-empty')).toBe(true);
  });
});

/** Planner says "change files"; the Coder runs the given tool calls once; the Reviewer approves. */
function team(calls: ToolCall[] | (() => ToolCall[])) {
  let coded = false;
  return new FakeClient([model('qwen2.5-coder:7b')], (req) => {
    const role = roleOf(req);
    if (role === 'planner') coded = false;
    if (role === 'planner') return { content: '```json\n{"needs_changes": true, "summary": "s", "steps": ["do it"], "files": []}\n```' };
    if (role === 'coder') {
      if (coded) return { content: 'Done.' };
      coded = true;
      return { content: '', toolCalls: typeof calls === 'function' ? calls() : calls };
    }
    return { content: '```json\n{"verdict": "approve", "issues": []}\n```' };
  });
}

describe('Session /undo', () => {
  it('reverts the last request, then the one before, and updates the agents’ context', async () => {
    const root = fs.realpathSync(tmpDir());
    write(root, 'app.js', 'v1\n');
    const config = loadConfig({ autoApprove: true, maxReviewCycles: 1 });
    const cmd = process.platform === 'win32' ? 'echo made> made.txt' : 'echo made > made.txt';
    let calls: ToolCall[] = [{ name: 'edit_file', arguments: { path: 'app.js', old_string: 'v1', new_string: 'v2' } }];
    const s1 = new Session({ client: team(() => calls), config, cwd: root });
    await s1.refreshModels();
    s1.setManualModel('qwen2.5-coder:7b');
    await s1.runTask('update app.js to v2', () => {}, async () => 'yes');
    expect(read(root, 'app.js')).toBe('v2\n');
    expect(s1.undoable).toEqual(['update app.js to v2']);

    // A command's changes are captured too.
    calls = [{ name: 'run_command', arguments: { command: cmd } }];
    await s1.runTask('add made.txt with a command', () => {}, async () => 'yes');
    expect(exists(root, 'made.txt')).toBe(true);
    expect(s1.undoable).toHaveLength(2);

    const r1 = s1.undo();
    expect(r1).toMatchObject({ status: 'done', task: 'add made.txt with a command', deleted: ['made.txt'], remaining: 1 });
    expect(exists(root, 'made.txt')).toBe(false);
    const r2 = s1.undo();
    expect(r2).toMatchObject({ status: 'done', restored: ['app.js'], remaining: 0 });
    expect(read(root, 'app.js')).toBe('v1\n');
    expect(s1.undo()).toEqual({ status: 'nothing' });
    expect(s1.snapshot().memory.every((m) => m.outcome.startsWith('Undone by the user'))).toBe(true);
  });

  it('removes a project folder the undone request created', async () => {
    const base = tmpDir();
    const projectsRoot = path.join(base, 'LocalLoom Projects');
    const client = team([{ name: 'write_file', arguments: { path: 'src/main.py', content: 'print(1)\n' } }]);
    const session = new Session({ client, config: loadConfig({ maxReviewCycles: 1 }), cwd: base, projectsRoot });
    await session.refreshModels();
    session.setManualModel('qwen2.5-coder:7b');
    await session.runTask('make a calculator app in python', () => {}, async () => 'yes');
    expect(fs.readdirSync(projectsRoot)).toEqual(['calculator-app']);
    const r = session.undo();
    expect(r).toMatchObject({ status: 'done', removedProject: true, deleted: ['src/main.py'] });
    expect(fs.readdirSync(projectsRoot)).toEqual([]);
    expect(session.project).toBeUndefined();
  });

  it('forgets checkpoints when another chat is resumed', async () => {
    const root = fs.realpathSync(tmpDir());
    const session = new Session({ client: team([{ name: 'write_file', arguments: { path: 'x.txt', content: 'x' } }]), config: loadConfig({ maxReviewCycles: 1 }), cwd: root });
    await session.refreshModels();
    session.setManualModel('qwen2.5-coder:7b');
    await session.runTask('create x.txt', () => {}, async () => 'yes');
    expect(session.undoable).toHaveLength(1);
    session.restore({ memory: [], workspaceRoot: root });
    expect(session.undo()).toEqual({ status: 'nothing' });
    expect(exists(root, 'x.txt')).toBe(true);
  });

  it('parses /undo force', () => {
    expect(parseCommand('/undo force')).toEqual({ name: '/undo', args: 'force' });
  });
});
