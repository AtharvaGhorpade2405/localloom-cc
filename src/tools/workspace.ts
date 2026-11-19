import fs from 'node:fs';
import path from 'node:path';
import { createTwoFilesPatch } from 'diff';

export class WorkspaceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkspaceError';
  }
}

/** Directories never descended into when listing or searching. */
export const IGNORED_DIRS = new Set([
  'node_modules',
  '.git',
  '.hg',
  '.svn',
  'dist',
  'build',
  'out',
  '.next',
  '.nuxt',
  '.turbo',
  '.cache',
  'coverage',
  '__pycache__',
  '.venv',
  'venv',
  '.mypy_cache',
  '.pytest_cache',
  'target',
  '.idea',
  '.gradle',
]);

function isInside(root: string, candidate: string): boolean {
  const rel = path.relative(root, candidate);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * The active project workspace. All file operations are resolved through it so that
 * agents cannot read or write outside the project directory (including via symlinks).
 */
export class Workspace {
  readonly root: string;
  private originals = new Map<string, string | null>();

  constructor(root: string) {
    this.root = fs.realpathSync(path.resolve(root));
  }

  /** Resolve a workspace-relative (or absolute-inside) path, rejecting anything that escapes the root. */
  resolve(p: string): string {
    if (typeof p !== 'string' || !p.trim()) throw new WorkspaceError('Path must be a non-empty string');
    const cleaned = p.trim().replace(/^["']|["']$/g, '');
    const abs = path.resolve(this.root, cleaned);
    if (!isInside(this.root, abs)) {
      throw new WorkspaceError(`Access denied: "${p}" is outside the project workspace (${this.root})`);
    }
    // Follow symlinks for the deepest existing ancestor so links can't escape the workspace.
    let existing = abs;
    while (!fs.existsSync(existing)) {
      const parent = path.dirname(existing);
      if (parent === existing) break;
      existing = parent;
    }
    const real = fs.realpathSync(existing);
    if (!isInside(this.root, real)) {
      throw new WorkspaceError(`Access denied: "${p}" resolves outside the project workspace via a symlink`);
    }
    return abs;
  }

  /** Resolve for writing: also blocks VCS internals. */
  resolveWritable(p: string): string {
    const abs = this.resolve(p);
    const rel = this.relative(abs);
    if (rel.split(/[\\/]/).some((seg) => seg === '.git' || seg === '.hg' || seg === '.svn')) {
      throw new WorkspaceError(`Refusing to modify version-control internals: ${rel}`);
    }
    if (abs === this.root) throw new WorkspaceError('Refusing to modify the workspace root itself');
    return abs;
  }

  relative(abs: string): string {
    const rel = path.relative(this.root, abs);
    return (rel || '.').split(path.sep).join('/');
  }

  /** Record a file's original content before the first modification in this task. */
  snapshot(abs: string): void {
    const rel = this.relative(abs);
    if (this.originals.has(rel)) return;
    this.originals.set(rel, fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : null);
  }

  /** True if the file existed before the current task started (i.e. it is not something the agents created). */
  existedBeforeTask(abs: string): boolean {
    const rel = this.relative(abs);
    if (this.originals.has(rel)) return this.originals.get(rel) !== null;
    return fs.existsSync(abs);
  }

  /** Original content (null: did not exist) of every file the file tools touched in this task. */
  originalEntries(): [string, string | null][] {
    return [...this.originals];
  }

  /** Start tracking a new task's changes. */
  resetChanges(): void {
    this.originals.clear();
  }

  changedFiles(): { path: string; status: 'created' | 'modified' | 'deleted' }[] {
    const out: { path: string; status: 'created' | 'modified' | 'deleted' }[] = [];
    for (const [rel, original] of this.originals) {
      const abs = path.join(this.root, rel);
      const exists = fs.existsSync(abs);
      if (original === null && exists) out.push({ path: rel, status: 'created' });
      else if (original !== null && !exists) out.push({ path: rel, status: 'deleted' });
      else if (original !== null && exists && fs.readFileSync(abs, 'utf8') !== original)
        out.push({ path: rel, status: 'modified' });
    }
    return out;
  }

  /** Unified diff of everything changed in the current task, truncated to `maxChars`. */
  diff(maxChars = 24000): string {
    const parts: string[] = [];
    for (const change of this.changedFiles()) {
      const abs = path.join(this.root, change.path);
      const before = this.originals.get(change.path) ?? '';
      const after = change.status === 'deleted' ? '' : fs.readFileSync(abs, 'utf8');
      parts.push(
        createTwoFilesPatch(
          change.status === 'created' ? '/dev/null' : `a/${change.path}`,
          change.status === 'deleted' ? '/dev/null' : `b/${change.path}`,
          before,
          after,
          '',
          '',
          { context: 3 },
        ),
      );
    }
    const full = parts.join('\n');
    if (full.length <= maxChars) return full;
    return `${full.slice(0, maxChars)}\n… [diff truncated, ${full.length - maxChars} more characters — read the files directly]`;
  }
}
