import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LoomEvent } from '../src/agents/events.js';
import { loadConfig } from '../src/config.js';
import { MultiClient } from '../src/core/multiClient.js';
import { Session } from '../src/core/session.js';
import { GroqClient, toOpenAIMessages } from '../src/groq/client.js';
import type { ModelInfo } from '../src/ollama/types.js';
import { pickGroqCoder, pickRouterModel } from '../src/router/heuristics.js';
import { FakeClient, model, roleOf, tmpDir } from './helpers.js';

afterEach(() => vi.unstubAllGlobals());

function sse(events: unknown[]): Response {
  const body = events.map((e) => `data: ${typeof e === 'string' ? e : JSON.stringify(e)}\n\n`).join('');
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

const groqModel = (id: string, opts: Partial<ModelInfo> = {}): ModelInfo =>
  model(`groq/${id}`, { provider: 'groq', sizeBytes: 0, contextLength: 131072, paramsB: 70, ...opts });

describe('GroqClient', () => {
  it('lists only chat models, with a groq/ prefix', async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({
        data: [
          { id: 'openai/gpt-oss-120b', context_window: 131072, owned_by: 'OpenAI', active: true },
          { id: 'llama-3.1-8b-instant', context_window: 131072, owned_by: 'Meta', active: true },
          { id: 'whisper-large-v3', context_window: 448, active: true },
          { id: 'meta-llama/llama-guard-4-12b', active: true },
          { id: 'old-model', active: false },
        ],
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const models = await new GroqClient({ apiKey: 'k' }).listModels();
    expect(models.map((m) => m.name)).toEqual(['groq/llama-3.1-8b-instant', 'groq/openai/gpt-oss-120b']);
    expect(models[1]).toMatchObject({ provider: 'groq', paramsB: 120, contextLength: 131072 });
    expect(models[0]!.paramsB).toBe(8);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.groq.com/openai/v1/models');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer k');
  });

  it('streams content, reasoning and tool calls', async () => {
    let sent: Record<string, unknown> = {};
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: RequestInit) => {
        sent = JSON.parse(String(init.body));
        return sse([
          { choices: [{ delta: { reasoning: 'Let me look.' } }] },
          { choices: [{ delta: { content: 'Reading ' } }] },
          { choices: [{ delta: { content: 'the file.' } }] },
          { choices: [{ delta: { tool_calls: [{ index: 0, id: 'x', function: { name: 'read_file', arguments: '{"pa' } }] } }] },
          { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'th": "a.py"}' } }] } }] },
          { choices: [{ delta: {}, finish_reason: 'tool_calls' }], x_groq: { usage: { prompt_tokens: 10, completion_tokens: 5 } } },
          '[DONE]',
        ]);
      }),
    );
    const deltas: string[] = [];
    const thinking: string[] = [];
    const res = await new GroqClient({ apiKey: 'k' }).chat(
      {
        model: 'groq/openai/gpt-oss-120b',
        messages: [{ role: 'user', content: 'hi' }],
        options: { temperature: 0.2, num_ctx: 16384, num_predict: 4096 },
        keepAlive: '10m',
      },
      { onContent: (d) => deltas.push(d), onThinking: (d) => thinking.push(d) },
    );
    expect(sent).toMatchObject({ model: 'openai/gpt-oss-120b', stream: true, temperature: 0.2, max_completion_tokens: 4096 });
    expect(sent).not.toHaveProperty('num_ctx');
    expect(res.content).toBe('Reading the file.');
    expect(deltas.join('')).toBe('Reading the file.');
    expect(thinking.join('')).toBe('Let me look.');
    expect(res.toolCalls).toEqual([{ name: 'read_file', arguments: { path: 'a.py' } }]);
    expect(res.promptTokens).toBe(10);
  });

  it('splits inline <think> blocks out of the content', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => sse([{ choices: [{ delta: { content: '<think>hmm' } }] }, { choices: [{ delta: { content: '</think>Answer' } }] }])));
    const res = await new GroqClient({ apiKey: 'k' }).chat({ model: 'groq/qwen/qwen3-32b', messages: [] });
    expect(res.content).toBe('Answer');
    expect(res.thinking).toBe('hmm');
  });

  it('waits and retries when rate limited', async () => {
    let calls = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        calls++;
        if (calls === 1) return new Response('{"error":{"message":"slow down"}}', { status: 429, headers: { 'retry-after': '0.01' } });
        return sse([{ choices: [{ delta: { content: 'ok' } }] }]);
      }),
    );
    const res = await new GroqClient({ apiKey: 'k' }).chat({ model: 'groq/m', messages: [] });
    expect(res.content).toBe('ok');
    expect(calls).toBe(2);
  });

  it('explains errors that retrying cannot fix', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ error: { message: 'Invalid API Key' } }, { status: 401 })));
    await expect(new GroqClient({ apiKey: 'bad' }).chat({ model: 'groq/m', messages: [] })).rejects.toThrow(/GROQ_API_KEY/);
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ error: { message: 'Limit 8000, Requested 12000' } }, { status: 413 })));
    await expect(new GroqClient({ apiKey: 'k' }).chat({ model: 'groq/m', messages: [] })).rejects.toThrow(/LOCALLOOM_GROQ_NUM_CTX/);
  });

  it('hands a malformed tool call back as text so the agent can correct it', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json(
          { error: { message: 'Failed to call a function', code: 'tool_use_failed', failed_generation: '{"name": "read_file", "arguments": {"path": "a.py"' } },
          { status: 400 },
        ),
      ),
    );
    const res = await new GroqClient({ apiKey: 'k' }).chat({ model: 'groq/m', messages: [] });
    expect(res.content).toContain('"read_file"');
    expect(res.toolCalls).toEqual([]);
  });

  it('converts tool calls and results to OpenAI messages with matching ids', () => {
    const out = toOpenAIMessages([
      { role: 'system', content: 's' },
      { role: 'assistant', content: '', tool_calls: [{ function: { name: 'read_file', arguments: { path: 'a' } } }, { function: { name: 'list_dir', arguments: {} } }] },
      { role: 'tool', content: 'A', tool_name: 'read_file' },
      { role: 'tool', content: 'B', tool_name: 'list_dir' },
      { role: 'tool', content: 'orphan', tool_name: 'x' },
    ]);
    expect(out[1]).toMatchObject({ role: 'assistant', content: null, tool_calls: [{ id: 'call_1_0', function: { name: 'read_file', arguments: '{"path":"a"}' } }, { id: 'call_1_1' }] });
    expect(out[2]).toEqual({ role: 'tool', tool_call_id: 'call_1_0', content: 'A' });
    expect(out[3]).toEqual({ role: 'tool', tool_call_id: 'call_1_1', content: 'B' });
    expect(out[4]).toMatchObject({ role: 'user', content: '[tool result: x]\norphan' });
  });
});

describe('local + Groq together', () => {
  const local = [model('qwen2.5-coder:7b'), model('qwen2.5-coder:1.5b', { paramsB: 1.5, sizeBytes: 986e6 })];
  const remote = [groqModel('openai/gpt-oss-120b', { paramsB: 120 }), groqModel('llama-3.3-70b-versatile')];

  it('sends each request to the backend that owns the model and survives Groq being offline', async () => {
    const ollama = new FakeClient(local, () => ({ content: 'local' }));
    const groq = new FakeClient(remote, () => ({ content: 'cloud' }));
    const multi = new MultiClient(ollama, groq);
    expect((await multi.listModels()).map((m) => m.name)).toEqual([...local, ...remote].map((m) => m.name));
    expect((await multi.chat({ model: 'groq/llama-3.3-70b-versatile', messages: [] })).content).toBe('cloud');
    expect((await multi.chat({ model: 'qwen2.5-coder:7b', messages: [] })).content).toBe('local');

    const offline = new MultiClient(ollama, { listModels: async () => Promise.reject(new Error('no internet')), chat: groq.chat.bind(groq) });
    expect(await offline.listModels()).toHaveLength(2);
    expect(offline.remoteError).toBe('no internet');
    expect(() => new MultiClient(ollama).chat({ model: 'groq/x', messages: [] })).toThrow(/GROQ_API_KEY/);
  });

  it('keeps the router local and picks the best Groq coder (or the preferred one)', () => {
    expect(pickRouterModel([...remote, ...local]).name).toBe('qwen2.5-coder:1.5b');
    expect(pickGroqCoder([...local, ...remote])!.name).toBe('groq/openai/gpt-oss-120b');
    expect(pickGroqCoder([...local, ...remote], 'llama-3.3-70b-versatile')!.name).toBe('groq/llama-3.3-70b-versatile');
    expect(pickGroqCoder(local)).toBeUndefined();
  });

  it('auto mode with Groq coding: Coder and Fixer on Groq, everything else local', async () => {
    const used: Record<string, string> = {};
    const all = [...local, ...remote];
    const client = new FakeClient(all, (req) => {
      const role = roleOf(req);
      used[role] = req.model;
      if (role === 'router') {
        // Even if the router names a cloud model, only local ones may be assigned by it.
        expect(req.messages[0]!.content).not.toContain('groq/');
        return { content: '{"complexity":"low","planner":"qwen2.5-coder:7b","coder":"qwen2.5-coder:7b","reviewer":"qwen2.5-coder:7b","fixer":"qwen2.5-coder:7b","reasoning":"r"}' };
      }
      if (role === 'planner') return { content: '{"needs_changes": true, "summary": "s", "steps": ["x"]}' };
      if (role === 'coder') return req.messages.at(-1)!.content.startsWith('[tool') ? { content: 'done' } : { content: '<write_file path="a.py">\nprint(1)\n</write_file>' };
      return { content: '{"verdict": "approve", "issues": []}' };
    });
    const session = new Session({ client, config: loadConfig({ groqCoding: true }), cwd: tmpDir() });
    const events: LoomEvent[] = [];
    await session.runTask('create a.py that prints 1', (e) => events.push(e), async () => 'yes');
    expect(used.router).toBe('qwen2.5-coder:1.5b');
    expect(used.planner).toBe('qwen2.5-coder:7b');
    expect(used.coder).toBe('groq/openai/gpt-oss-120b');
    expect(used.reviewer).toBe('qwen2.5-coder:7b');
    const routing = events.find((e) => e.type === 'routing') as Extract<LoomEvent, { type: 'routing' }>;
    expect(routing.result.assignment.fixer).toBe('groq/openai/gpt-oss-120b');

    // Turned off, nothing goes to Groq.
    session.groqCoding = false;
    for (const k of Object.keys(used)) delete used[k];
    await session.runTask('create b.py that prints 2', () => {}, async () => 'yes');
    expect(Object.values(used).some((m) => m.startsWith('groq/'))).toBe(false);
  });

  it('warns and stays local when Groq coding is on but no Groq model is available', async () => {
    const client = new FakeClient(local, (req) => {
      const role = roleOf(req);
      if (role === 'router') return { content: '{"complexity":"low","planner":"qwen2.5-coder:7b","coder":"qwen2.5-coder:7b","reviewer":"qwen2.5-coder:7b","fixer":"qwen2.5-coder:7b","reasoning":"r"}' };
      return { content: 'hello\n{"needs_changes": false, "summary": "answered"}' };
    });
    const session = new Session({ client, config: loadConfig({ groqCoding: true }), cwd: tmpDir() });
    const events: LoomEvent[] = [];
    await session.runTask('hi', (e) => events.push(e), async () => 'yes');
    expect(events.some((e) => e.type === 'notice' && /no Groq model is available/.test(e.text))).toBe(true);
  });

  it('defaults Manual mode to a local model even when Groq models are listed', async () => {
    const session = new Session({ client: new FakeClient([...local, ...remote], () => ({ content: '' })), config: loadConfig(), cwd: tmpDir() });
    await session.refreshModels();
    expect(session.defaultModel()).toBe('qwen2.5-coder:7b');
  });
});

describe('Groq tool calls', () => {
  it('reports a tool call Groq refused instead of failing the request', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json(
          { error: { message: "tool call validation failed: attempted to call tool 'write_file' which was not in request.tools", type: 'invalid_request_error' } },
          { status: 400 },
        ),
      ),
    );
    const res = await new GroqClient({ apiKey: 'k' }).chat({ model: 'groq/m', messages: [] });
    expect(res.toolError).toMatch(/not in request.tools/);
    expect(res.content).toBe('');
  });

  it('offers Groq coders the file tools natively and lets them retry after a rejected call', async () => {
    let coderTurn = 0;
    const local = model('qwen2.5-coder:7b');
    const remote = groqModel('openai/gpt-oss-120b', { paramsB: 120 });
    const client = new FakeClient([local, remote], (req) => {
      const role = roleOf(req);
      if (role === 'router') return { content: '{"complexity":"low","planner":"qwen2.5-coder:7b","coder":"qwen2.5-coder:7b","reviewer":"qwen2.5-coder:7b","fixer":"qwen2.5-coder:7b","reasoning":"r"}' };
      if (role === 'planner') return { content: '{"needs_changes": true, "summary": "s", "steps": ["x"]}' };
      if (role === 'coder') {
        expect(req.model).toBe('groq/openai/gpt-oss-120b');
        expect(req.tools!.map((t) => t.function.name)).toEqual(expect.arrayContaining(['write_file', 'edit_file']));
        coderTurn++;
        if (coderTurn === 1) return { content: '', toolError: 'tool call validation failed' };
        if (coderTurn === 2) {
          expect(req.messages.at(-1)!.content).toMatch(/rejected: tool call validation failed/);
          return { content: '', toolCalls: [{ name: 'write_file', arguments: { path: 'index.html', content: '<h1>Login</h1>\n' } }] };
        }
        return { content: 'Created index.html.' };
      }
      return { content: '{"verdict": "approve", "issues": []}' };
    });
    const root = tmpDir();
    const session = new Session({ client, config: loadConfig({ groqCoding: true }), cwd: root });
    const events: LoomEvent[] = [];
    await session.runTask('create a login page', (e) => events.push(e), async () => 'yes');
    expect((events.at(-1) as { status: string }).status).toBe('done');
    expect(fs.readFileSync(path.join(root, 'index.html'), 'utf8')).toBe('<h1>Login</h1>\n');
  });
});
