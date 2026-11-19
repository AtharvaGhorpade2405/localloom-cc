import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { IGNORED_DIRS } from '../tools/workspace.js';

/**
 * Checkpoints for /undo. Before each request LocalLoom copies the project folder into memory
 * (a "baseline"); afterwards it keeps only what that request changed (a "checkpoint"), so the
 * changes can be reverted later — including changes made by commands, not just by the file tools.
 *
 * Folders in IGNORED_DIRS (node_modules, .git, build output, virtualenvs, …) are never copied or
 * touched. A folder too large to copy falls back to the file tools' own change tracking.
 */

export interface BaselineLimits {
  maxFiles?: number;
  maxBytes?: number;
}

export const BASELINE_MAX_FILES = 5000;
export const BASELINE_MAX_BYTES = 64 * 1024 * 1024;

export interface Baseline {
  root: string;
  files: Map<string, Buffer>;
  dirs: Set<string>;
  /** False when the folder was too large to copy: only changes made through the file tools can be undone. */
  complete: boolean;
}

export interface FileChange {
  path: string;
  /** Content before the request, or null when the request created the file. */
  before: Buffer | null;
  /** Hash of the content right after the request (null: deleted), used to detect later edits. */
  afterHash: string | null;
}

export interface Checkpoint {
  task: string;
  root: string;
  createdAt: string;
  changes: FileChange[];
  /** Folders the request created, deepest first. */
  newDirs: string[];
  complete: boolean;
  /** Set when the request created this project folder; it is removed again if undo leaves it empty. */
  projectDir?: string;
}

export interface UndoOutcome {
  /** Files changed after the request; nothing is reverted unless `force` is set. */
  conflicts: string[];
  applied: boolean;
  restored: string[];
  deleted: string[];
  failed: string[];
}

const hash = (buf: Buffer) => crypto.createHash('sha1').update(buf).digest('hex');

const toRel = (root: string, abs: string) => path.relative(root, abs).split(path.sep).join('/');

/** True for paths LocalLoom snapshots (not inside node_modules, .git, …). */
function inScope(rel: string): boolean {
  return !rel.split('/').some((seg) => IGNORED_DIRS.has(seg));
}

function walk(root: string, onDir: (rel: string) => void, onFile: (rel: string, abs: string) => boolean): void {
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (IGNORED_DIRS.has(e.name)) continue;
        onDir(toRel(root, abs));
        stack.push(abs);
      } else if (e.isFile()) {
        if (!onFile(toRel(root, abs), abs)) return;
      }
    }
  }
}

function readOrNull(abs: string): Buffer | null {
  try {
    return fs.statSync(abs).isFile() ? fs.readFileSync(abs) : null;
  } catch {
    return null;
  }
}

/** Copy the folder's files into memory before a request runs. */
export function captureBaseline(root: string, limits: BaselineLimits = {}): Baseline {
  const maxFiles = limits.maxFiles ?? BASELINE_MAX_FILES;
  const maxBytes = limits.maxBytes ?? BASELINE_MAX_BYTES;
  const files = new Map<string, Buffer>();
  const dirs = new Set<string>();
  let bytes = 0;
  let complete = true;
  walk(
    root,
    (rel) => dirs.add(rel),
    (rel, abs) => {
      let size: number;
      try {
        size = fs.statSync(abs).size;
      } catch {
        return true;
      }
      bytes += size;
      if (files.size + 1 > maxFiles || bytes > maxBytes) {
        complete = false;
        return false;
      }
      try {
        files.set(rel, fs.readFileSync(abs));
      } catch {
        /* unreadable files are not tracked */
      }
      return true;
    },
  );
  if (!complete) files.clear();
  return { root, files, dirs, complete };
}

/**
 * Compare the folder with its baseline and keep only what changed. `toolOriginals` are the file
 * tools' own records (path → original text, null if created), used for paths the baseline could
 * not cover. Returns undefined when nothing changed.
 */
export function buildCheckpoint(
  baseline: Baseline,
  toolOriginals: Iterable<[string, string | null]>,
  task: string,
): Checkpoint | undefined {
  const { root } = baseline;
  const befores = new Map<string, Buffer | null>();
  const currentDirs = new Set<string>();

  if (baseline.complete) {
    const seen = new Set<string>();
    walk(
      root,
      (rel) => currentDirs.add(rel),
      (rel, abs) => {
        seen.add(rel);
        const before = baseline.files.get(rel);
        if (before === undefined) befores.set(rel, null);
        else {
          const now = readOrNull(abs);
          if (!now || !now.equals(before)) befores.set(rel, before);
        }
        return true;
      },
    );
    for (const [rel, before] of baseline.files) if (!seen.has(rel)) befores.set(rel, before);
  } else {
    walk(root, (rel) => currentDirs.add(rel), () => true);
  }

  for (const [rel, original] of toolOriginals) {
    if (befores.has(rel) || (baseline.complete && inScope(rel))) continue;
    const before = original === null ? null : Buffer.from(original, 'utf8');
    const now = readOrNull(path.join(root, rel));
    const same = before === null ? now === null : !!now && now.equals(before);
    if (!same) befores.set(rel, before);
  }

  const changes: FileChange[] = [...befores]
    .map(([rel, before]) => {
      const now = readOrNull(path.join(root, rel));
      return { path: rel, before, afterHash: now ? hash(now) : null };
    })
    .sort((a, b) => a.path.localeCompare(b.path));
  // An incomplete baseline stopped early, so its folder list is incomplete too: never guess there.
  const newDirs = [...(baseline.complete ? currentDirs : [])]
    .filter((d) => !baseline.dirs.has(d))
    .sort((a, b) => b.split('/').length - a.split('/').length || b.localeCompare(a));
  if (!changes.length && !newDirs.length) return undefined;
  return { task, root, createdAt: new Date().toISOString(), changes, newDirs, complete: baseline.complete };
}

/** Files whose content differs from what the request left behind. */
export function findConflicts(cp: Checkpoint): string[] {
  return cp.changes
    .filter((c) => {
      const now = readOrNull(path.join(cp.root, c.path));
      return (now ? hash(now) : null) !== c.afterHash;
    })
    .map((c) => c.path);
}

function safePath(root: string, rel: string): string {
  const abs = path.resolve(root, rel);
  const r = path.relative(root, abs);
  if (!r || r.startsWith('..') || path.isAbsolute(r)) throw new Error(`Refusing to touch ${rel}: outside ${root}`);
  return abs;
}

/** Put every file back the way it was before the request. */
export function undoCheckpoint(cp: Checkpoint, opts: { force?: boolean } = {}): UndoOutcome {
  const out: UndoOutcome = { conflicts: [], applied: false, restored: [], deleted: [], failed: [] };
  if (!fs.existsSync(cp.root)) throw new Error(`The folder ${cp.root} no longer exists.`);
  out.conflicts = findConflicts(cp);
  if (out.conflicts.length && !opts.force) return out;
  for (const c of cp.changes) {
    try {
      const abs = safePath(cp.root, c.path);
      if (c.before === null) {
        if (fs.existsSync(abs)) {
          fs.rmSync(abs, { force: true });
          out.deleted.push(c.path);
        }
      } else {
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, c.before);
        out.restored.push(c.path);
      }
    } catch {
      out.failed.push(c.path);
    }
  }
  for (const d of cp.newDirs) {
    try {
      const abs = safePath(cp.root, d);
      if (fs.existsSync(abs) && fs.readdirSync(abs).length === 0) fs.rmdirSync(abs);
    } catch {
      /* not empty or already gone */
    }
  }
  out.applied = true;
  return out;
}
