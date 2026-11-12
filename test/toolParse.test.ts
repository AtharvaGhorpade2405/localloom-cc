import { describe, expect, it } from 'vitest';
import { extractTrailingJson, parseTextToolCalls, stripTrailingJsonBlock } from '../src/agents/toolParse.js';
import { getTool } from '../src/tools/registry.js';

const known = (n: string) => !!getTool(n);

describe('parseTextToolCalls', () => {
  it('parses a bare JSON tool call', () => {
    const { calls, rest } = parseTextToolCalls('{"name": "read_file", "arguments": {"path": "a.ts"}}', known);
    expect(calls).toEqual([{ name: 'read_file', arguments: { path: 'a.ts' } }]);
    expect(rest).toBe('');
  });

  it('parses qwen-style <tool_call> tags and fenced blocks with prose', () => {
    const text = 'Let me look.\n<tool_call>\n{"name":"list_dir","arguments":{"path":"."}}\n</tool_call>';
    const { calls, rest } = parseTextToolCalls(text, known);
    expect(calls[0]!.name).toBe('list_dir');
    expect(rest).toBe('Let me look.');
    const fenced = parseTextToolCalls('```json\n{"tool": "write_file", "args": {"path": "x", "content": "a{b}\\"c"}}\n```', known);
    expect(fenced.calls[0]).toEqual({ name: 'write_file', arguments: { path: 'x', content: 'a{b}"c' } });
  });

  it('supports OpenAI-like function objects with string arguments', () => {
    const { calls } = parseTextToolCalls('{"function": {"name": "search_code", "arguments": "{\\"pattern\\": \\"foo\\"}"}}', known);
    expect(calls).toEqual([{ name: 'search_code', arguments: { pattern: 'foo' } }]);
  });

  it('ignores JSON that is not a known tool call', () => {
    const { calls, rest } = parseTextToolCalls('Plan:\n```json\n{"needs_changes": true, "steps": []}\n```', known);
    expect(calls).toEqual([]);
    expect(rest).toContain('needs_changes');
  });
});

describe('trailing JSON helpers', () => {
  const reply = 'Here is the plan.\n1. Do X\n```json\n{"needs_changes": true, "summary": "s", "steps": ["a"]}\n```';
  it('extracts the trailing block', () => {
    expect(extractTrailingJson(reply, 'needs_changes')).toMatchObject({ needs_changes: true, summary: 's' });
    expect(extractTrailingJson(reply, 'verdict')).toBeUndefined();
  });
  it('strips it for display', () => {
    expect(stripTrailingJsonBlock(reply, 'needs_changes')).toBe('Here is the plan.\n1. Do X');
  });
});
