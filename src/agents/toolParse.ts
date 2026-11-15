import type { ToolCall } from '../ollama/types.js';

/** Extract balanced top-level JSON object/array substrings from free text. */
export function extractJsonCandidates(text: string): { start: number; end: number; json: string }[] {
  const out: { start: number; end: number; json: string }[] = [];
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch !== '{' && ch !== '[') {
      i++;
      continue;
    }
    let depth = 0;
    let inStr = false;
    let esc = false;
    let j = i;
    for (; j < text.length; j++) {
      const c = text[j];
      if (inStr) {
        if (esc) esc = false;
        else if (c === '\\') esc = true;
        else if (c === '"') inStr = false;
        continue;
      }
      if (c === '"') inStr = true;
      else if (c === '{' || c === '[') depth++;
      else if (c === '}' || c === ']') {
        depth--;
        if (depth === 0) break;
      }
    }
    if (depth === 0 && j < text.length) {
      out.push({ start: i, end: j + 1, json: text.slice(i, j + 1) });
      i = j + 1;
    } else {
      i++;
    }
  }
  return out;
}

function asObject(v: unknown): Record<string, unknown> | undefined {
  if (v && typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>;
  if (typeof v === 'string') {
    try {
      return asObject(JSON.parse(v));
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function toCall(v: unknown, isKnownTool: (name: string) => boolean): ToolCall | undefined {
  const o = asObject(v);
  if (!o) return undefined;
  const fn = asObject(o.function);
  const name = (fn?.name ?? o.name ?? o.tool ?? o.tool_name ?? o.action) as unknown;
  if (typeof name !== 'string' || !isKnownTool(name)) return undefined;
  const args =
    asObject(fn?.arguments) ??
    asObject(o.arguments) ??
    asObject(o.parameters) ??
    asObject(o.args) ??
    asObject(o.input) ??
    asObject(o.action_input) ??
    {};
  return { name, arguments: args };
}

/**
 * Repair JSON the way small models typically break it when embedding source code in a string:
 * raw newlines/tabs/control characters, invalid escapes such as \' and, optionally, unescaped
 * double quotes inside strings (`aggressive`).
 */
export function repairJson(s: string, aggressive = false): string {
  let out = '';
  let inStr = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (!inStr) {
      if (c === '"') inStr = true;
      out += c;
      continue;
    }
    if (c === '\\') {
      const n = s[i + 1];
      if (n !== undefined && '"\\/bfnrtu'.includes(n)) {
        out += c + n;
        i++;
      } else if (n === "'") {
        out += "'";
        i++;
      } else {
        out += '\\\\';
      }
      continue;
    }
    if (c === '"') {
      if (aggressive) {
        // Only treat the quote as closing when the next significant character makes sense after a string.
        let j = i + 1;
        while (j < s.length && /\s/.test(s[j]!)) j++;
        const next = s[j];
        if (next !== undefined && next !== ',' && next !== '}' && next !== ']' && next !== ':') {
          out += '\\"';
          continue;
        }
      }
      inStr = false;
      out += c;
      continue;
    }
    if (c === '\n') out += '\\n';
    else if (c === '\r') out += '\\r';
    else if (c === '\t') out += '\\t';
    else if (c < ' ') out += `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`;
    else out += c;
  }
  return out;
}

/** JSON.parse with progressively more forgiving repairs. Returns undefined if nothing works. */
export function parseJsonLenient(s: string): unknown {
  const attempts = [
    () => s,
    () => repairJson(s),
    () => repairJson(s).replace(/,\s*([}\]])/g, '$1'),
    () => repairJson(s, true),
  ];
  for (const attempt of attempts) {
    try {
      return JSON.parse(attempt());
    } catch {
      /* next */
    }
  }
  return undefined;
}

/** Strip a single code fence that wraps a whole block (models often fence file contents). */
function unfence(content: string): string {
  const m = /^\s*```[\w+.-]*[ \t]*\r?\n([\s\S]*?)\r?\n?```\s*$/.exec(content);
  return m ? m[1]! : content;
}

function ensureTrailingNewline(s: string): string {
  return s.length && !s.endsWith('\n') ? `${s}\n` : s;
}

const WRITE_BLOCK = /<write_file\s+path\s*=\s*["']([^"'\n]+)["']\s*>[ \t]*\r?\n?([\s\S]*?)<\/write_file>/g;
const EDIT_BLOCK =
  /<edit_file\s+path\s*=\s*["']([^"'\n]+)["']\s*>\s*<old>[ \t]*\r?\n?([\s\S]*?)\r?\n?<\/old>\s*<new>[ \t]*\r?\n?([\s\S]*?)\r?\n?<\/new>\s*<\/edit_file>/g;

export interface ParsedText {
  calls: ToolCall[];
  /** Prose with the tool-call payloads removed. */
  rest: string;
  /** Attempted tool calls that could not be understood — must be reported back to the model. */
  errors: string[];
}

/**
 * Parse tool calls a model wrote as text (for models without native tool calling, or that
 * ignore it). Supports raw file blocks (<write_file path="…">…</write_file>, <edit_file>) and
 * JSON calls, repairing common JSON mistakes. Unparseable attempts are reported in `errors`
 * instead of being silently treated as prose.
 */
export function parseTextToolCalls(text: string, isKnownTool: (name: string) => boolean): ParsedText {
  const calls: { at: number; call: ToolCall }[] = [];
  const errors: string[] = [];
  const ranges: [number, number][] = [];

  // 1. Raw blocks: file content needs no escaping, which small models handle far better than JSON.
  for (const m of text.matchAll(WRITE_BLOCK)) {
    calls.push({ at: m.index!, call: { name: 'write_file', arguments: { path: m[1]!.trim(), content: ensureTrailingNewline(unfence(m[2]!)) } } });
    ranges.push([m.index!, m.index! + m[0].length]);
  }
  for (const m of text.matchAll(EDIT_BLOCK)) {
    calls.push({
      at: m.index!,
      call: { name: 'edit_file', arguments: { path: m[1]!.trim(), old_string: unfence(m[2]!), new_string: unfence(m[3]!) } },
    });
    ranges.push([m.index!, m.index! + m[0].length]);
  }
  const inRange = (pos: number) => ranges.some(([s, e]) => pos >= s && pos < e);
  const masked = ranges.reduce((t, [s, e]) => t.slice(0, s) + ' '.repeat(e - s) + t.slice(e), text);
  if (/<write_file\b/.test(masked) || /<edit_file\b/.test(masked)) {
    errors.push(
      'A <write_file>/<edit_file> block was malformed or not closed. Use exactly: <write_file path="relative/path">…full content…</write_file>, or <edit_file path="…"><old>exact old text</old><new>replacement</new></edit_file>.',
    );
  }

  // 2. JSON calls.
  for (const cand of extractJsonCandidates(masked)) {
    if (inRange(cand.start)) continue;
    const parsed = parseJsonLenient(cand.json);
    if (parsed === undefined) {
      const named = /"(?:name|tool|tool_name|action)"\s*:\s*"([\w-]+)"/.exec(cand.json);
      if (named && isKnownTool(named[1]!)) {
        errors.push(
          `Your ${named[1]} call was not valid JSON, so it was NOT executed.` +
            (/write_file|edit_file/.test(named[1]!)
              ? ' For file contents use the raw block format instead of JSON: <write_file path="file.py">…full content…</write_file>'
              : ' Escape quotes and newlines inside strings.'),
        );
        ranges.push([cand.start, cand.end]);
      }
      continue;
    }
    const items = Array.isArray(parsed) ? parsed : [parsed];
    const found = items.map((it) => toCall(it, isKnownTool)).filter((c): c is ToolCall => !!c);
    if (found.length && found.length === items.length) {
      for (const call of found) calls.push({ at: cand.start, call });
      ranges.push([cand.start, cand.end]);
    }
  }

  // A JSON-looking call that never closed (e.g. truncated output).
  if (!calls.length && !errors.length) {
    const open = /\{\s*"(?:name|tool)"\s*:\s*"([\w-]+)"/.exec(masked);
    if (open && isKnownTool(open[1]!)) {
      errors.push(`Your ${open[1]} call was incomplete (the JSON never closed), so it was NOT executed.`);
      ranges.push([open.index, text.length]);
    }
  }

  let rest = text;
  for (const [s, e] of [...ranges].sort((a, b) => b[0] - a[0])) rest = rest.slice(0, s) + rest.slice(e);
  rest = rest
    .replace(/<\/?tool_call>/g, '')
    .replace(/```(?:json|tool|tool_call|xml|html)?\s*```/g, '')
    .trim();
  return { calls: calls.sort((a, b) => a.at - b.at).map((c) => c.call), rest, errors };
}

/** Find the last JSON object in a reply that contains the given key. */
export function extractTrailingJson(text: string, requiredKey: string): Record<string, unknown> | undefined {
  const cands = extractJsonCandidates(text).reverse();
  for (const c of cands) {
    try {
      const v = parseJsonLenient(c.json) as Record<string, unknown> | undefined;
      if (v && typeof v === 'object' && !Array.isArray(v) && requiredKey in v) return v as Record<string, unknown>;
    } catch {
      /* try next */
    }
  }
  return undefined;
}

/** Remove a trailing machine-readable JSON block (and its fence) from text shown to the user. */
export function stripTrailingJsonBlock(text: string, requiredKey: string): string {
  const cands = extractJsonCandidates(text).reverse();
  for (const c of cands) {
    try {
      const v = parseJsonLenient(c.json) as Record<string, unknown> | undefined;
      if (v && typeof v === 'object' && requiredKey in v) {
        let before = text.slice(0, c.start);
        let after = text.slice(c.end);
        before = before.replace(/```(?:json)?\s*$/i, '');
        after = after.replace(/^\s*```/, '');
        return `${before}${after}`.trim();
      }
    } catch {
      /* next */
    }
  }
  return text.trim();
}
