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

describe('robust text tool calls (models without native tool calling)', () => {
  it('repairs JSON with raw newlines inside the file content (real qwen/deepseek failure)', () => {
    // Mostly-escaped content with a few literal newlines — invalid JSON that was previously dropped silently.
    const broken =
      '```json\n{"name": "write_file", "arguments": {"path": "calc.py", "content": "import tkinter as tk\n\nbuttons = [\'7\', \'8\',\n            \'4\', \'5\']\nprint(\\"hi\\")\n"}}\n```';
    const { calls, errors, rest } = parseTextToolCalls(broken, known);
    expect(errors).toEqual([]);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.arguments.content).toBe('import tkinter as tk\n\nbuttons = [\'7\', \'8\',\n            \'4\', \'5\']\nprint("hi")\n');
    expect(rest).toBe('');
  });

  it('parses raw <write_file> and <edit_file> blocks without any escaping', () => {
    const text = [
      'Creating the app.',
      '<write_file path="calc.py">',
      '```python',
      'label = "a {brace} and \\"quotes\\""',
      'print(label)',
      '```',
      '</write_file>',
      '<edit_file path="main.py">',
      '<old>',
      'x = 1',
      '</old>',
      '<new>',
      'x = 2',
      '</new>',
      '</edit_file>',
    ].join('\n');
    const { calls, errors, rest } = parseTextToolCalls(text, known);
    expect(errors).toEqual([]);
    expect(calls).toEqual([
      { name: 'write_file', arguments: { path: 'calc.py', content: 'label = "a {brace} and \\"quotes\\""\nprint(label)\n' } },
      { name: 'edit_file', arguments: { path: 'main.py', old_string: 'x = 1', new_string: 'x = 2' } },
    ]);
    expect(rest).toBe('Creating the app.');
  });

  it('reports unparseable or truncated calls instead of silently ignoring them', () => {
    const garbage = parseTextToolCalls('{"name": "write_file", "arguments": {"path": "a.py", "content": "x = {"}} oops }', known);
    expect(garbage.calls.length + garbage.errors.length).toBeGreaterThan(0);
    const truncated = parseTextToolCalls('{"name": "write_file", "arguments": {"path": "a.py", "content": "print(1)', known);
    expect(truncated.calls).toEqual([]);
    expect(truncated.errors[0]).toMatch(/incomplete/);
    const unclosed = parseTextToolCalls('<write_file path="a.py">\nprint(1)\n', known);
    expect(unclosed.errors[0]).toMatch(/malformed or not closed/);
  });
});
