import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { LoomEvent } from '../src/agents/events.js';
import { loadConfig } from '../src/config.js';
import { parsePlan, parseReview, Session } from '../src/core/session.js';
import { FakeClient, model, roleOf, tmpDir } from './helpers.js';

const approveAll = async () => 'yes' as const;

function collect() {
  const events: LoomEvent[] = [];
  return { events, emit: (e: LoomEvent) => events.push(e) };
}

describe('plan/review parsing', () => {
  it('parses plans and falls back on request wording', () => {
    expect(parsePlan('ok\n{"needs_changes": false, "summary": "q"}', 'x').needsChanges).toBe(false);
    expect(parsePlan('no json here', 'add a login page').needsChanges).toBe(true);
    expect(parsePlan('no json here', 'what does this do?').needsChanges).toBe(false);
  });
  it('parses reviews', () => {
    expect(parseReview('{"verdict": "approve", "issues": []}').approved).toBe(true);
    const r = parseReview('{"verdict": "changes_requested", "issues": [{"file": "a", "problem": "bug", "fix": "f"}]}');
    expect(r.approved).toBe(false);
    expect(r.issues).toEqual([{ file: 'a', problem: 'bug', fix: 'f' }]);
    expect(parseReview('Looks good to me').approved).toBe(true);
  });
});

describe('Session four-agent pipeline', () => {
  it('runs planner → coder → reviewer → fixer → reviewer with native tool calls', async () => {
    const root = tmpDir();
    let reviews = 0;
    let coderTurn = 0;
    let fixerTurn = 0;
    const client = new FakeClient([model('qwen2.5-coder:7b')], (req) => {
      const role = roleOf(req);
      if (role === 'planner') {
        return { content: 'Plan:\n1. Create add.js\n```json\n{"needs_changes": true, "summary": "add function", "steps": ["create add.js"], "files": ["add.js"]}\n```' };
      }
      if (role === 'coder') {
        coderTurn++;
        if (coderTurn === 1)
          return { content: '', toolCalls: [{ name: 'write_file', arguments: { path: 'add.js', content: 'export const add = (a, b) => a - b;\n' } }] };
        return { content: 'Created add.js.' };
      }
      if (role === 'reviewer') {
        reviews++;
        // The reviewer must receive the diff.
        expect(req.messages[1]!.content).toContain('+export const add');
        if (reviews === 1)
          return { content: 'Bug found.\n```json\n{"verdict": "changes_requested", "issues": [{"file": "add.js", "problem": "subtracts instead of adds", "fix": "use +"}]}\n```' };
        return { content: '```json\n{"verdict": "approve", "issues": []}\n```' };
      }
      if (role === 'fixer') {
        fixerTurn++;
        expect(req.messages[1]!.content).toContain('subtracts instead of adds');
        if (fixerTurn === 1)
          return { content: '', toolCalls: [{ name: 'edit_file', arguments: { path: 'add.js', old_string: 'a - b', new_string: 'a + b' } }] };
        return { content: 'Fixed the operator.' };
      }
      throw new Error(`unexpected role ${role}`);
    });
    const session = new Session({ client, config: loadConfig({ maxReviewCycles: 3 }), cwd: root });
    await session.refreshModels();
    session.setManualModel('qwen2.5-coder:7b');
    const { events, emit } = collect();
    await session.runTask('Create add.js exporting an add function that adds two numbers across modules with tests and a refactor', emit, approveAll);

    expect(fs.readFileSync(path.join(root, 'add.js'), 'utf8')).toBe('export const add = (a, b) => a + b;\n');
    const starts = events.filter((e) => e.type === 'agent:start').map((e) => (e as { agent: string }).agent);
    expect(starts).toEqual(['planner', 'coder', 'reviewer', 'fixer', 'reviewer']);
    const end = events.find((e) => e.type === 'task:end') as Extract<LoomEvent, { type: 'task:end' }>;
    expect(end.status).toBe('done');
    expect(end.summary).toMatch(/approved/);
    expect(end.changedFiles).toEqual(['add.js (created)']);
    expect(events.some((e) => e.type === 'tool:end' && e.name === 'write_file' && e.ok)).toBe(true);
  });

  it('answers questions with the planner only', async () => {
    const root = tmpDir();
    const client = new FakeClient([model('qwen2.5-coder:7b')], (req) => {
      expect(roleOf(req)).toBe('planner');
      return { content: 'This project is empty.\n{"needs_changes": false, "summary": "answered"}' };
    });
    const session = new Session({ client, config: loadConfig(), cwd: root });
    const { events, emit } = collect();
    await session.runTask('what is in this project?', emit, approveAll);
    const skipped = events.filter((e) => e.type === 'agent:end' && e.status === 'skipped').length;
    expect(skipped).toBe(3);
    expect(client.calls).toHaveLength(1);
    const msg = events.find((e) => e.type === 'agent:message') as Extract<LoomEvent, { type: 'agent:message' }>;
    expect(msg.content).toContain('This project is empty.');
  });

  it('supports models without native tools via the text protocol and nudges lazy coders', async () => {
    const root = tmpDir();
    let coderTurn = 0;
    const client = new FakeClient([model('plain:7b', { capabilities: ['completion'] })], (req) => {
      const role = roleOf(req);
      if (role === 'planner') return { content: '{"needs_changes": true, "summary": "s", "steps": ["write hi.txt"]}' };
      if (role === 'coder') {
        expect(req.tools).toBeUndefined();
        expect(req.messages[0]!.content).toContain('To call a tool, reply with ONLY a JSON object');
        coderTurn++;
        if (coderTurn === 1) return { content: 'Here is the code:\n```\nhi\n```' }; // lazy: no tool call
        if (coderTurn === 2) {
          expect(req.messages.at(-1)!.content).toMatch(/not changed any files/);
          return { content: '{"name": "write_file", "arguments": {"path": "hi.txt", "content": "hi"}}' };
        }
        expect(req.messages.at(-1)!.content).toMatch(/^\[tool result: write_file\]/);
        return { content: 'Done.' };
      }
      return { content: '{"verdict": "approve", "issues": []}' };
    });
    const session = new Session({ client, config: loadConfig(), cwd: root });
    const { events, emit } = collect();
    await session.runTask('create hi.txt', emit, approveAll);
    expect(fs.readFileSync(path.join(root, 'hi.txt'), 'utf8')).toBe('hi');
    expect((events.at(-1) as { status: string }).status).toBe('done');
  });

  it('respects the review cycle limit', async () => {
    const root = tmpDir();
    const client = new FakeClient([model('qwen2.5-coder:7b')], (req) => {
      const role = roleOf(req);
      if (role === 'planner') return { content: '{"needs_changes": true, "summary": "s", "steps": ["x"]}' };
      if (role === 'reviewer') return { content: '{"verdict": "changes_requested", "issues": ["still wrong"]}' };
      const last = req.messages.at(-1)!;
      if (last.role === 'tool') return { content: 'done' };
      return { content: '', toolCalls: [{ name: 'write_file', arguments: { path: 'f.txt', content: String(Math.random()) } }] };
    });
    const session = new Session({ client, config: loadConfig({ maxReviewCycles: 2 }), cwd: root });
    const { events, emit } = collect();
    await session.runTask('Refactor the entire architecture across multiple files for performance and security', emit, approveAll);
    const reviewers = events.filter((e) => e.type === 'agent:start' && e.agent === 'reviewer').length;
    const fixers = events.filter((e) => e.type === 'agent:start' && e.agent === 'fixer').length;
    expect(reviewers).toBe(2);
    expect(fixers).toBe(2);
    const end = events.at(-1) as Extract<LoomEvent, { type: 'task:end' }>;
    expect(end.summary).toMatch(/limit/);
  });

  it('ends a looping agent turn after repeated identical failures and hands off to the reviewer', async () => {
    const root = tmpDir();
    let coderCalls = 0;
    const client = new FakeClient([model('qwen2.5-coder:7b')], (req) => {
      const role = roleOf(req);
      if (role === 'planner') return { content: '{"needs_changes": true, "summary": "s", "steps": ["x"]}' };
      if (role === 'coder') {
        coderCalls++;
        return { content: 'Trying again.', toolCalls: [{ name: 'run_command', arguments: { command: `node -e "process.exit(3)"` } }] };
      }
      if (role === 'reviewer') {
        expect(req.messages[1]!.content).toContain('I got stuck');
        return { content: '{"verdict": "approve", "issues": []}' };
      }
      return { content: 'ok' };
    });
    const session = new Session({ client, config: loadConfig({ autoApprove: true }), cwd: root });
    const { events, emit } = collect();
    await session.runTask('fix the build', emit, approveAll);
    expect(coderCalls).toBe(4);
    expect(events.some((e) => e.type === 'notice' && /same failure/.test(e.text))).toBe(true);
    expect(events.filter((e) => e.type === 'agent:start').map((e) => (e as { agent: string }).agent)).toContain('reviewer');
  });

  it('overrides a reviewer approval when the automatic syntax check fails', async () => {
    const root = tmpDir();
    let fixed = false;
    const client = new FakeClient([model('plain:7b', { capabilities: ['completion'] })], (req) => {
      const role = roleOf(req);
      const last = req.messages.at(-1)!.content;
      if (role === 'planner') return { content: '{"needs_changes": true, "summary": "s", "steps": ["write app.js"]}' };
      if (role === 'coder') {
        if (last.startsWith('[tool result')) return { content: 'Wrote app.js' };
        return { content: '<write_file path="app.js">\nconst total = (a, b) => { return a + b;\n</write_file>' };
      }
      if (role === 'reviewer') {
        if (!fixed) expect(last).toContain('FAIL (node --check)');
        return { content: '{"verdict": "approve", "issues": []}' }; // a lazy reviewer approves anyway
      }
      // fixer
      if (last.startsWith('[tool result')) return { content: 'Fixed the missing brace.' };
      expect(last).toContain('Syntax check failed');
      fixed = true;
      return { content: '<write_file path="app.js">\nconst total = (a, b) => { return a + b; };\nmodule.exports = { total };\n</write_file>' };
    });
    const session = new Session({ client, config: loadConfig(), cwd: root });
    const { events, emit } = collect();
    await session.runTask('create app.js with a total function', emit, approveAll);
    expect(fixed).toBe(true);
    expect(fs.readFileSync(path.join(root, 'app.js'), 'utf8')).toContain('module.exports');
    const end = events.at(-1) as Extract<LoomEvent, { type: 'task:end' }>;
    expect(end.summary).toMatch(/approved.*Syntax checks pass/);
  });

  it('feeds malformed tool calls back to the model instead of dropping them', async () => {
    const root = tmpDir();
    let coderTurn = 0;
    const client = new FakeClient([model('plain:7b', { capabilities: ['completion'] })], (req) => {
      const role = roleOf(req);
      if (role === 'planner') return { content: '{"needs_changes": true, "summary": "s", "steps": ["x"]}' };
      if (role === 'coder') {
        coderTurn++;
        if (coderTurn === 1) return { content: '{"name": "write_file", "arguments": {"path": "a.txt", "content": "unterminated' };
        if (coderTurn === 2) {
          expect(req.messages.at(-1)!.content).toMatch(/^\[tool error\][\s\S]*NOT executed/);
          return { content: '<write_file path="a.txt">\nhello\n</write_file>' };
        }
        return { content: 'done' };
      }
      return { content: '{"verdict": "approve", "issues": []}' };
    });
    const session = new Session({ client, config: loadConfig(), cwd: root });
    const { events, emit } = collect();
    await session.runTask('create a.txt', emit, approveAll);
    expect(fs.readFileSync(path.join(root, 'a.txt'), 'utf8')).toBe('hello\n');
    expect(events.some((e) => e.type === 'notice' && /malformed tool call/.test(e.text))).toBe(true);
  });

  it('cancels cleanly', async () => {
    const root = tmpDir();
    const ac = new AbortController();
    const client = new FakeClient([model('qwen2.5-coder:7b')], () => {
      ac.abort();
      return { content: '', toolCalls: [{ name: 'list_dir', arguments: {} }] };
    });
    const session = new Session({ client, config: loadConfig(), cwd: root });
    const { events, emit } = collect();
    await session.runTask('add something', emit, approveAll, ac.signal);
    expect((events.at(-1) as { status: string }).status).toBe('cancelled');
  });

  it('auto mode routes with the SLM and reports errors without crashing', async () => {
    const root = tmpDir();
    const models = [model('qwen2.5-coder:7b'), model('llama3.2:3b', { paramsB: 3.2, parameterSize: '3.2B', family: 'llama' })];
    const client = new FakeClient(models, (req) => {
      const role = roleOf(req);
      if (role === 'router') {
        return { content: '{"complexity":"low","planner":"llama3.2:3b","coder":"qwen2.5-coder:7b","reviewer":"llama3.2:3b","fixer":"qwen2.5-coder:7b","reasoning":"r"}' };
      }
      if (role === 'planner') {
        expect(req.model).toBe('llama3.2:3b');
        throw new Error('model exploded');
      }
      return { content: '' };
    });
    const session = new Session({ client, config: loadConfig(), cwd: root });
    const { events, emit } = collect();
    await session.runTask('hi', emit, approveAll);
    const routing = events.find((e) => e.type === 'routing') as Extract<LoomEvent, { type: 'routing' }>;
    expect(routing.result.source).toBe('slm');
    const end = events.at(-1) as Extract<LoomEvent, { type: 'task:end' }>;
    expect(end.status).toBe('error');
    expect(end.summary).toMatch(/exploded/);
  });
});
