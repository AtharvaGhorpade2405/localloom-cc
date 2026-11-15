import fs from 'node:fs';
import path from 'node:path';
import picomatch from 'picomatch';
import { IGNORED_DIRS, type Workspace } from './workspace.js';

const MAX_FILE_BYTES = 1_000_000;

export function isProbablyBinary(buf: Buffer): boolean {
  const len = Math.min(buf.length, 8000);
  for (let i = 0; i < len; i++) if (buf[i] === 0) return true;
  return false;
}

/** Walk the workspace yielding file paths (absolute), skipping ignored directories. */
export function* walkFiles(root: string, start: string, maxFiles = 20000): Generator<string> {
  const stack = [start];
  let count = 0;
  while (stack.length) {
    const dir = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const e of entries) {
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!IGNORED_DIRS.has(e.name)) stack.push(abs);
      } else if (e.isFile()) {
        yield abs;
        if (++count >= maxFiles) return;
      }
    }
  }
  void root;
}

export function listDir(ws: Workspace, p: string, depth: number): string {
  const abs = ws.resolve(p);
  if (!fs.existsSync(abs)) throw new Error(`Directory not found: ${p}`);
  if (!fs.statSync(abs).isDirectory()) throw new Error(`Not a directory: ${p}`);
  const lines: string[] = [];
  const MAX = 400;
  const walk = (dir: string, prefix: string, level: number) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
    for (const e of entries) {
      if (lines.length >= MAX) return;
      if (e.isDirectory()) {
        const skipped = IGNORED_DIRS.has(e.name);
        lines.push(`${prefix}${e.name}/${skipped ? ' (skipped)' : ''}`);
        if (!skipped && level < depth) walk(path.join(dir, e.name), `${prefix}  `, level + 1);
      } else {
        let size = '';
        try {
          size = ` (${fs.statSync(path.join(dir, e.name)).size} B)`;
        } catch {
          /* ignore */
        }
        lines.push(`${prefix}${e.name}${size}`);
      }
    }
  };
  walk(abs, '', 1);
  if (lines.length >= MAX) lines.push(`… (truncated at ${MAX} entries)`);
  return lines.length ? lines.join('\n') : '(empty directory)';
}

export function readFile(ws: Workspace, p: string, startLine?: number, endLine?: number): { text: string; lines: number } {
  const abs = ws.resolve(p);
  if (!fs.existsSync(abs)) throw new Error(`File not found: ${p}`);
  const stat = fs.statSync(abs);
  if (stat.isDirectory()) throw new Error(`"${p}" is a directory — use list_dir instead`);
  if (stat.size > MAX_FILE_BYTES * 5) throw new Error(`File too large to read (${stat.size} bytes)`);
  const buf = fs.readFileSync(abs);
  if (isProbablyBinary(buf)) throw new Error(`"${p}" appears to be a binary file`);
  const all = buf.toString('utf8').split(/\r?\n/);
  const total = all.length;
  const MAX_LINES = 600;
  const start = Math.max(1, startLine ?? 1);
  let end = Math.min(total, endLine ?? total);
  let note = '';
  if (end - start + 1 > MAX_LINES) {
    end = start + MAX_LINES - 1;
    note = `\n… [showing lines ${start}-${end} of ${total}; call read_file with start_line=${end + 1} to continue]`;
  }
  const width = String(end).length;
  const body = all
    .slice(start - 1, end)
    .map((line, i) => `${String(start + i).padStart(width, ' ')}│ ${line}`)
    .join('\n');
  let text = `${ws.relative(abs)} (${total} lines)\n${body}${note}`;
  if (text.length > 60000) text = `${text.slice(0, 60000)}\n… [truncated]`;
  return { text, lines: end - start + 1 };
}

export function writeFile(ws: Workspace, p: string, content: string): { created: boolean; lines: number } {
  const abs = ws.resolveWritable(p);
  if (fs.existsSync(abs) && fs.statSync(abs).isDirectory()) throw new Error(`"${p}" is a directory`);
  const created = !fs.existsSync(abs);
  ws.snapshot(abs);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, 'utf8');
  return { created, lines: content.split('\n').length };
}

function normalizeWs(s: string): string {
  return s
    .split(/\r?\n/)
    .map((l) => l.trimEnd())
    .join('\n');
}

/** Line-number prefixes from read_file output ("12│ code") that models sometimes copy into old_string. */
const LINE_NO_PREFIX = /^\s*\d+\s*│ ?/;

function stripLineNumbers(s: string): string {
  const lines = s.split('\n');
  const nonEmpty = lines.filter((l) => l.trim());
  if (nonEmpty.length && nonEmpty.every((l) => LINE_NO_PREFIX.test(l))) return lines.map((l) => l.replace(LINE_NO_PREFIX, '')).join('\n');
  return s;
}

function trimBlankLines(lines: string[]): string[] {
  let a = 0;
  let b = lines.length;
  while (a < b && !lines[a]!.trim()) a++;
  while (b > a && !lines[b - 1]!.trim()) b--;
  return lines.slice(a, b);
}

const indentOf = (l: string) => /^[ \t]*/.exec(l)![0];

/** Start indices where `block` matches `lines` ignoring indentation and surrounding whitespace. */
function findBlockIgnoringIndent(lines: string[], block: string[]): number[] {
  const target = block.map((l) => l.trim());
  const hits: number[] = [];
  if (!target.length) return hits;
  for (let i = 0; i + target.length <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < target.length; j++) {
      if (lines[i + j]!.trim() !== target[j]) {
        ok = false;
        break;
      }
    }
    if (ok) hits.push(i);
  }
  return hits;
}

function bigrams(s: string): Map<string, number> {
  const m = new Map<string, number>();
  const t = s.replace(/\s+/g, ' ');
  for (let i = 0; i < t.length - 1; i++) {
    const g = t.slice(i, i + 2);
    m.set(g, (m.get(g) ?? 0) + 1);
  }
  return m;
}

function similarity(a: string, b: string): number {
  const A = bigrams(a);
  const B = bigrams(b);
  let inter = 0;
  let total = 0;
  for (const [g, n] of A) {
    inter += Math.min(n, B.get(g) ?? 0);
    total += n;
  }
  for (const n of B.values()) total += n;
  return total ? (2 * inter) / total : 0;
}

/** The region of the file that most resembles what the model tried to replace (for the error message). */
export function closestRegion(content: string, oldString: string): { start: number; end: number; text: string } | undefined {
  const lines = content.split('\n');
  const target = trimBlankLines(oldString.split('\n'));
  if (!target.length || lines.length > 5000) return undefined;
  const k = Math.min(target.length, lines.length, 60);
  const want = target.slice(0, k).join('\n');
  let best = { i: 0, score: -1 };
  for (let i = 0; i + k <= lines.length; i++) {
    const score = similarity(lines.slice(i, i + k).join('\n'), want);
    if (score > best.score) best = { i, score };
  }
  if (best.score < 0.3) return undefined;
  return { start: best.i + 1, end: best.i + k, text: lines.slice(best.i, best.i + k).join('\n') };
}

export function editFile(
  ws: Workspace,
  p: string,
  oldString: string,
  newString: string,
  replaceAll = false,
): { replacements: number; note?: string } {
  const abs = ws.resolveWritable(p);
  if (!fs.existsSync(abs)) throw new Error(`File not found: ${p}. Use write_file to create new files.`);
  const original = fs.readFileSync(abs, 'utf8');
  if (oldString === '') throw new Error('old_string must not be empty. Use write_file to replace a whole file.');
  const usesCrlf = original.includes('\r\n');
  let content = usesCrlf ? original.replace(/\r\n/g, '\n') : original;
  const oldN = stripLineNumbers(oldString.replace(/\r\n/g, '\n'));
  const newN = stripLineNumbers(newString.replace(/\r\n/g, '\n'));
  const tooMany = (n: number) =>
    new Error(`old_string matches ${n} places in ${p}; include more surrounding lines to make it unique, or set replace_all=true.`);

  let replacements = 1;
  let note: string | undefined;
  const exact = content.split(oldN).length - 1;
  const normContent = normalizeWs(content);
  const normOld = normalizeWs(oldN);
  const loose = exact ? 0 : normContent.split(normOld).length - 1;
  if (exact) {
    if (exact > 1 && !replaceAll) throw tooMany(exact);
    content = replaceAll ? content.split(oldN).join(newN) : content.replace(oldN, () => newN);
    replacements = replaceAll ? exact : 1;
  } else if (loose) {
    // Only trailing-whitespace differences.
    if (loose > 1 && !replaceAll) throw tooMany(loose);
    content = replaceAll ? normContent.split(normOld).join(newN) : normContent.replace(normOld, () => newN);
    replacements = replaceAll ? loose : 1;
  } else {
    // Indentation differences: match whole lines ignoring leading whitespace, then re-indent the replacement.
    const lines = content.split('\n');
    const oldLines = trimBlankLines(oldN.split('\n'));
    const hits = findBlockIgnoringIndent(lines, oldLines);
    if (hits.length === 0) {
      const near = closestRegion(content, oldN);
      const total = lines.length;
      throw new Error(
        `old_string not found in ${p}: it must match the file character for character — do not retype code from memory.` +
          (near
            ? `\nThe closest lines in the file are:\n${numberedLines(lines, near.start, near.end)}\nIf that is the part you meant, do NOT retype it: call edit_file again with start_line=${near.start}, end_line=${near.end} and new_string to replace exactly those lines.`
            : '\nUse read_file to find the right lines, then call edit_file with start_line, end_line and new_string.') +
          ` Do not rewrite the whole file (${total} lines) — change only the lines that need to change.`,
      );
    }
    if (hits.length > 1 && !replaceAll) throw tooMany(hits.length);
    const oldIndent = indentOf(oldLines[0]!);
    for (const start of [...hits].reverse()) {
      const fileIndent = indentOf(lines[start]!);
      const replacement = newN === '' ? [] : trimBlankLines(newN.split('\n')).map((l) => (l.startsWith(oldIndent) && l.trim() ? fileIndent + l.slice(oldIndent.length) : l));
      lines.splice(start, oldLines.length, ...replacement);
      if (!replaceAll) break;
    }
    content = lines.join('\n');
    replacements = replaceAll ? hits.length : 1;
    note = 'matched ignoring indentation; the replacement was re-indented to fit';
  }
  ws.snapshot(abs);
  fs.writeFileSync(abs, usesCrlf ? content.replace(/\n/g, '\r\n') : content, 'utf8');
  return { replacements, note };
}

/** Lines [from, to] (1-based, inclusive) formatted like read_file output. */
export function numberedLines(lines: string[], from: number, to: number): string {
  const a = Math.max(1, from);
  const b = Math.min(lines.length, to);
  const width = String(b).length;
  const out: string[] = [];
  for (let i = a; i <= b; i++) out.push(`${String(i).padStart(width, ' ')}│ ${lines[i - 1]}`);
  return out.join('\n');
}

/**
 * Replace lines [startLine, endLine] (1-based, inclusive) with newString. Small models can edit by
 * line number instead of retyping the old code exactly. If `expectedOld` is given it must roughly
 * match the current lines, which guards against stale line numbers.
 */
export function editLines(
  ws: Workspace,
  p: string,
  startLine: number,
  endLine: number,
  newString: string,
  expectedOld?: string,
): { removed: number; inserted: number; snippet: string; reindented: boolean } {
  const abs = ws.resolveWritable(p);
  if (!fs.existsSync(abs)) throw new Error(`File not found: ${p}. Use write_file to create new files.`);
  const original = fs.readFileSync(abs, 'utf8');
  const usesCrlf = original.includes('\r\n');
  const lines = (usesCrlf ? original.replace(/\r\n/g, '\n') : original).split('\n');
  const hasFinalNewline = lines.length > 1 && lines[lines.length - 1] === '';
  const count = hasFinalNewline ? lines.length - 1 : lines.length;
  if (
    !Number.isInteger(startLine) ||
    !Number.isInteger(endLine) ||
    startLine < 1 ||
    endLine < startLine - 1 ||
    startLine > count + 1 ||
    endLine > count
  ) {
    throw new Error(
      `Invalid line range ${startLine}-${endLine} for ${p} (the file has ${count} lines). Use 1 ≤ start_line ≤ end_line ≤ ${count}; to insert without removing anything use end_line = start_line - 1.`,
    );
  }
  const current = lines.slice(startLine - 1, endLine).join('\n');
  if (expectedOld !== undefined && expectedOld.trim() && current.trim()) {
    const want = stripLineNumbers(expectedOld.replace(/\r\n/g, '\n'));
    if (similarity(current, want) < 0.5) {
      throw new Error(
        `Lines ${startLine}-${endLine} of ${p} do not look like your old_string — the line numbers are probably stale. Current lines:\n${numberedLines(lines, startLine, endLine)}\nRe-read the file and try again.`,
      );
    }
  }
  let replacement =
    newString === '' ? [] : stripLineNumbers(newString.replace(/\r\n/g, '\n')).replace(/\n$/, '').split('\n');
  // Small models often drop all indentation from replacement lines; in indentation-sensitive code that
  // breaks the file. If the new lines have no indentation at all but the replaced lines did, restore it.
  let reindented = false;
  const minIndent = (ls: string[]) => {
    const ind = ls.filter((l) => l.trim()).map((l) => indentOf(l));
    return ind.length ? ind.reduce((a, b) => (b.length < a.length ? b : a)) : '';
  };
  const oldIndent = minIndent(lines.slice(startLine - 1, endLine));
  if (replacement.length && oldIndent && minIndent(replacement) === '') {
    replacement = replacement.map((l) => (l.trim() ? oldIndent + l : l));
    reindented = true;
  }
  lines.splice(startLine - 1, endLine - startLine + 1, ...replacement);
  ws.snapshot(abs);
  const content = lines.join('\n');
  fs.writeFileSync(abs, usesCrlf ? content.replace(/\n/g, '\r\n') : content, 'utf8');
  return {
    removed: endLine - startLine + 1,
    inserted: replacement.length,
    reindented,
    snippet: numberedLines(lines, startLine - 3, startLine + replacement.length + 2),
  };
}

/** The region around `needle` with fresh line numbers, so the agent can chain further edits. */
export function snippetAround(ws: Workspace, p: string, needle: string): string {
  const lines = fs.readFileSync(ws.resolve(p), 'utf8').replace(/\r\n/g, '\n').split('\n');
  const needleLines = needle.split('\n');
  const first = needleLines.find((l) => l.trim());
  if (!first) return '';
  const idx = lines.findIndex((l) => l.includes(first.trim()));
  if (idx === -1) return '';
  return numberedLines(lines, idx + 1 - 3, idx + needleLines.length + 3);
}

export function deleteFile(ws: Workspace, p: string): void {
  const abs = ws.resolveWritable(p);
  if (!fs.existsSync(abs)) throw new Error(`File not found: ${p}`);
  if (fs.statSync(abs).isDirectory()) throw new Error(`"${p}" is a directory; only files can be deleted`);
  ws.snapshot(abs);
  fs.unlinkSync(abs);
}

export interface SearchOptions {
  pattern: string;
  path?: string;
  glob?: string;
  regex?: boolean;
  caseSensitive?: boolean;
  maxResults?: number;
}

export function searchCode(ws: Workspace, opts: SearchOptions): { text: string; matches: number } {
  const start = ws.resolve(opts.path ?? '.');
  const flags = opts.caseSensitive ? 'g' : 'gi';
  let re: RegExp;
  try {
    re = opts.regex === false ? new RegExp(escapeRegex(opts.pattern), flags) : new RegExp(opts.pattern, flags);
  } catch {
    re = new RegExp(escapeRegex(opts.pattern), flags);
  }
  const isMatch = opts.glob ? picomatch(opts.glob, { dot: true, basename: !opts.glob.includes('/') }) : null;
  const max = opts.maxResults ?? 80;
  const out: string[] = [];
  let matches = 0;
  const files = fs.existsSync(start) && fs.statSync(start).isFile() ? [start] : walkFiles(ws.root, start);
  for (const abs of files) {
    const rel = ws.relative(abs);
    if (isMatch && !isMatch(rel)) continue;
    let buf: Buffer;
    try {
      if (fs.statSync(abs).size > MAX_FILE_BYTES) continue;
      buf = fs.readFileSync(abs);
    } catch {
      continue;
    }
    if (isProbablyBinary(buf)) continue;
    const lines = buf.toString('utf8').split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      re.lastIndex = 0;
      if (re.test(lines[i]!)) {
        matches++;
        const line = lines[i]!.length > 220 ? `${lines[i]!.slice(0, 220)}…` : lines[i]!;
        out.push(`${rel}:${i + 1}: ${line.trim()}`);
        if (matches >= max) {
          out.push(`… (stopped after ${max} matches; narrow the search with path or glob)`);
          return { text: out.join('\n'), matches };
        }
      }
    }
  }
  return { text: out.length ? out.join('\n') : 'No matches found.', matches };
}

export function findFiles(ws: Workspace, pattern: string, maxResults = 200): { text: string; count: number } {
  const glob = pattern.includes('/') || pattern.startsWith('**') ? pattern : `**/${pattern}`;
  const isMatch = picomatch(glob, { dot: true, nocase: true });
  const out: string[] = [];
  for (const abs of walkFiles(ws.root, ws.root)) {
    const rel = ws.relative(abs);
    if (isMatch(rel)) {
      out.push(rel);
      if (out.length >= maxResults) {
        out.push(`… (stopped after ${maxResults} files)`);
        break;
      }
    }
  }
  return { text: out.length ? out.join('\n') : 'No files matched.', count: out.length };
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
