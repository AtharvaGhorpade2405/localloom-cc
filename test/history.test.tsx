import fs from 'node:fs';
import path from 'node:path';
import { render } from 'ink-testing-library';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { HISTORY_VERSION, HistoryStore, newSessionId, titleFor, type SessionRecord } from '../src/core/history.js';
import { Session } from '../src/core/session.js';
import { App } from '../src/ui/App.js';
import { parseCommand } from '../src/ui/commands.js';
import { FakeClient, model, roleOf, tmpDir } from './helpers.js';

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn: () => boolean, timeout = 4000) {
  const start = Date.now();
  while (!fn()) {
    if (Date.now() - start > timeout) throw new Error('timeout');
    await wait(20);
  }
}

function record(id: string, text: string, updatedAt: string, extra: Partial<SessionRecord> = {}): SessionRecord {
  const items = [{ kind: 'user', text }];
  return {
    version: HISTORY_VERSION,
    id,
    title: titleFor(items),
    createdAt: updatedAt,
    updatedAt,
    cwd: '/x',
    mode: 'auto',
    items,
    memory: [{ request: text, outcome: 'ok' }],
    workspaceRoot: '/x',
    ...extra,
  };
}

describe('HistoryStore', () => {
  it('saves, lists newest first, resolves and deletes', () => {
    const store = new HistoryStore(path.join(tmpDir(), 'sessions'));
    expect(store.list()).toEqual([]);
    store.save(record('a1', 'first chat', '2026-01-01T00:00:00.000Z'));
    store.save(record('b2', 'second chat', '2026-02-01T00:00:00.000Z'));
    fs.writeFileSync(path.join(store.dir, 'junk.json'), '{not json');
    const list = store.list();
    expect(list.map((s) => s.id)).toEqual(['b2', 'a1']);
    expect(list[0]).toMatchObject({ title: 'second chat', messages: 1 });
    expect(store.resolve('2')?.id).toBe('a1');
    expect(store.resolve('b')?.id).toBe('b2');
    expect(store.load('a1').memory).toEqual([{ request: 'first chat', outcome: 'ok' }]);
    expect(store.delete('a1')).toBe(true);
    expect(store.list().map((s) => s.id)).toEqual(['b2']);
    expect(() => store.load('../evil')).toThrow(/Invalid session id/);
  });

  it('makes sortable unique ids', () => {
    const a = newSessionId(new Date('2026-03-04T05:06:07Z'));
    expect(a).toMatch(/^20260304-050607-[0-9a-f]{6}$/);
    expect(newSessionId()).not.toBe(newSessionId());
  });

  it('parses /session aliases', () => {
    expect(parseCommand('/session 2')).toEqual({ name: '/session', args: '2' });
    expect(parseCommand('/resume')?.name).toBe('/session');
  });
});

describe('Session.restore', () => {
  it('restores memory and an existing project folder', () => {
    const root = tmpDir();
    const projects = path.join(root, 'LocalLoom Projects');
    const s = new Session({ client: new FakeClient([], () => ({})), config: loadConfig(), cwd: root, projectsRoot: projects });
    const dir = path.join(projects, 'calc');
    fs.mkdirSync(dir, { recursive: true });
    expect(s.restore({ memory: [{ request: 'r', outcome: 'o' }], project: { name: 'calc', dir }, workspaceRoot: dir })).toBeUndefined();
    expect(s.memorySize).toBe(1);
    expect(s.project?.name).toBe('calc');
    expect(s.workspace.root).toBe(fs.realpathSync(dir));
    const warn = s.restore({ memory: [], project: { name: 'gone', dir: path.join(projects, 'gone') }, workspaceRoot: '' });
    expect(warn).toMatch(/no longer exists/);
    expect(s.project).toBeUndefined();
  });
});

describe('App chat history', () => {
  it('saves chats and resumes one with /session', async () => {
    const store = new HistoryStore(path.join(tmpDir(), 'sessions'));
    const client = new FakeClient([model('qwen2.5-coder:7b')], (req) =>
      roleOf(req) === 'planner' ? { content: 'Hi from the planner.\n{"needs_changes": false, "summary": "greeting"}' } : { content: '' },
    );
    const session = new Session({ client, config: loadConfig(), cwd: tmpDir() });
    const app = render(<App session={session} history={store} />);
    await waitFor(() => app.frames.join('\n').includes('Auto mode'));
    app.stdin.write('remember the word banana');
    await wait(30);
    app.stdin.write('\r');
    await waitFor(() => app.frames.join('\n').includes('Done'));
    await waitFor(() => store.list().length === 1);
    const saved = store.load(store.list()[0]!.id);
    expect(saved.title).toBe('remember the word banana');
    expect(saved.items.some((i) => i.kind === 'agent')).toBe(true);
    expect(saved.memory.length).toBe(1);
    app.unmount();

    // A fresh app (new process) can browse and reopen it.
    const session2 = new Session({ client, config: loadConfig(), cwd: tmpDir() });
    const app2 = render(<App session={session2} history={store} />);
    await waitFor(() => app2.frames.join('\n').includes('Auto mode'));
    app2.stdin.write('/session');
    await wait(30);
    app2.stdin.write('\r');
    await waitFor(() => (app2.lastFrame() ?? '').includes('Chat history'));
    expect(app2.lastFrame()).toContain('remember the word banana');
    app2.stdin.write('\r');
    await waitFor(() => app2.frames.join('\n').includes('Resumed chat'));
    expect(session2.memorySize).toBe(1);
    expect(app2.frames.join('\n')).toContain('Hi from the planner.');
    app2.unmount();
  });
});
