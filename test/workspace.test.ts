import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { Workspace } from '../src/tools/workspace.js';
import { tmpDir } from './helpers.js';

describe('Workspace', () => {
  it('resolves paths inside the root', () => {
    const root = tmpDir();
    const ws = new Workspace(root);
    expect(ws.resolve('src/a.ts')).toBe(path.join(ws.root, 'src', 'a.ts'));
    expect(ws.resolve('.')).toBe(ws.root);
    expect(ws.resolve(path.join(ws.root, 'x.txt'))).toBe(path.join(ws.root, 'x.txt'));
  });

  it('rejects traversal and absolute paths outside the root', () => {
    const ws = new Workspace(tmpDir());
    expect(() => ws.resolve('../outside.txt')).toThrow(/outside the project/);
    expect(() => ws.resolve('a/../../b')).toThrow(/outside the project/);
    expect(() => ws.resolve(path.parse(ws.root).root)).toThrow(/outside the project/);
    expect(() => ws.resolve('')).toThrow();
  });

  it('rejects symlinks escaping the workspace', () => {
    const root = tmpDir();
    const outside = tmpDir();
    const ws = new Workspace(root);
    try {
      fs.symlinkSync(outside, path.join(root, 'link'), 'junction');
    } catch {
      return; // symlinks not permitted on this system
    }
    expect(() => ws.resolve('link/secret.txt')).toThrow(/symlink/);
  });

  it('blocks writes to VCS internals and the root', () => {
    const ws = new Workspace(tmpDir());
    expect(() => ws.resolveWritable('.git/config')).toThrow(/version-control/);
    expect(() => ws.resolveWritable('.')).toThrow();
  });

  it('tracks changes and produces a diff', () => {
    const root = tmpDir();
    fs.writeFileSync(path.join(root, 'a.txt'), 'one\ntwo\n');
    const ws = new Workspace(root);
    ws.snapshot(path.join(ws.root, 'a.txt'));
    fs.writeFileSync(path.join(root, 'a.txt'), 'one\nTWO\n');
    ws.snapshot(path.join(ws.root, 'b.txt'));
    fs.writeFileSync(path.join(root, 'b.txt'), 'new\n');
    const changes = ws.changedFiles();
    expect(changes).toEqual([
      { path: 'a.txt', status: 'modified' },
      { path: 'b.txt', status: 'created' },
    ]);
    const diff = ws.diff();
    expect(diff).toContain('-two');
    expect(diff).toContain('+TWO');
    expect(diff).toContain('+new');
    ws.resetChanges();
    expect(ws.changedFiles()).toEqual([]);
  });
});
