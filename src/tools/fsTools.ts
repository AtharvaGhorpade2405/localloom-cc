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

export function editFile(
  ws: Workspace,
  p: string,
  oldString: string,
  newString: string,
  replaceAll = false,
): { replacements: number } {
  const abs = ws.resolveWritable(p);
  if (!fs.existsSync(abs)) throw new Error(`File not found: ${p}. Use write_file to create new files.`);
  const original = fs.readFileSync(abs, 'utf8');
  if (oldString === '') throw new Error('old_string must not be empty. Use write_file to replace a whole file.');
  const usesCrlf = original.includes('\r\n');
  let content = usesCrlf ? original.replace(/\r\n/g, '\n') : original;
  const oldN = oldString.replace(/\r\n/g, '\n');
  const newN = newString.replace(/\r\n/g, '\n');

  let count = content.split(oldN).length - 1;
  if (count === 0) {
    // Retry ignoring trailing whitespace differences, line by line.
    const normContent = normalizeWs(content);
    const normOld = normalizeWs(oldN);
    const c2 = normContent.split(normOld).length - 1;
    if (c2 === 0) {
      throw new Error(
        `old_string not found in ${p}. Read the file again and copy the exact text (including indentation) you want to replace.`,
      );
    }
    content = normContent;
    count = c2;
    if (count > 1 && !replaceAll) {
      throw new Error(`old_string matches ${count} places in ${p}; include more surrounding context or set replace_all=true.`);
    }
    content = replaceAll ? content.split(normOld).join(newN) : content.replace(normOld, () => newN);
  } else {
    if (count > 1 && !replaceAll) {
      throw new Error(`old_string matches ${count} places in ${p}; include more surrounding context or set replace_all=true.`);
    }
    content = replaceAll ? content.split(oldN).join(newN) : content.replace(oldN, () => newN);
  }
  ws.snapshot(abs);
  fs.writeFileSync(abs, usesCrlf ? content.replace(/\n/g, '\r\n') : content, 'utf8');
  return { replacements: replaceAll ? count : 1 };
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
