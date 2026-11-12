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
 * Parse tool calls a model wrote as text (for models without native tool calling, or that
 * ignore it). Returns the calls and the remaining prose with the call payloads removed.
 */
export function parseTextToolCalls(
  text: string,
  isKnownTool: (name: string) => boolean,
): { calls: ToolCall[]; rest: string } {
  const calls: ToolCall[] = [];
  const ranges: [number, number][] = [];
  for (const cand of extractJsonCandidates(text)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(cand.json);
    } catch {
      continue;
    }
    const items = Array.isArray(parsed) ? parsed : [parsed];
    const found = items.map((it) => toCall(it, isKnownTool)).filter((c): c is ToolCall => !!c);
    if (found.length && found.length === items.length) {
      calls.push(...found);
      ranges.push([cand.start, cand.end]);
    }
  }
  let rest = text;
  for (const [s, e] of ranges.reverse()) rest = rest.slice(0, s) + rest.slice(e);
  rest = rest
    .replace(/<\/?tool_call>/g, '')
    .replace(/```(?:json|tool|tool_call)?\s*```/g, '')
    .trim();
  return { calls, rest };
}

/** Find the last JSON object in a reply that contains the given key. */
export function extractTrailingJson(text: string, requiredKey: string): Record<string, unknown> | undefined {
  const cands = extractJsonCandidates(text).reverse();
  for (const c of cands) {
    try {
      const v = JSON.parse(c.json);
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
      const v = JSON.parse(c.json);
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
