import { describe, expect, it } from 'vitest';
import { parseParamsB, profileModel, resolveModelName } from '../src/ollama/modelProfile.js';
import { estimateComplexity, heuristicAssignment, pickRouterModel } from '../src/router/heuristics.js';
import { routeTask } from '../src/router/router.js';
import { FakeClient, model } from './helpers.js';

const MODELS = [
  model('qwen2.5-coder:7b'),
  model('llama3.2:3b', { paramsB: 3.2, parameterSize: '3.2B', sizeBytes: 2e9, family: 'llama' }),
  model('deepseek-r1:14b', { paramsB: 14, parameterSize: '14B', sizeBytes: 9e9, capabilities: ['completion', 'thinking'] }),
  model('nomic-embed-text:latest', { paramsB: 0.137, capabilities: ['embedding'], family: 'nomic-bert' }),
];

describe('model profiling', () => {
  it('parses parameter sizes', () => {
    expect(parseParamsB('7.6B')).toBeCloseTo(7.6);
    expect(parseParamsB('770M')).toBeCloseTo(0.77);
    expect(parseParamsB('', 'llama3:8b')).toBe(8);
  });
  it('detects roles', () => {
    expect(profileModel(MODELS[0]!).coding).toBe(true);
    expect(profileModel(MODELS[2]!).reasoning).toBe(true);
    expect(profileModel(MODELS[3]!).embedding).toBe(true);
  });
  it('resolves names tolerantly', () => {
    expect(resolveModelName('QWEN2.5-coder:7b', MODELS)?.name).toBe('qwen2.5-coder:7b');
    expect(resolveModelName('nomic-embed-text', MODELS)?.name).toBe('nomic-embed-text:latest');
    expect(resolveModelName('gpt-4', MODELS)).toBeUndefined();
  });
});

describe('heuristics', () => {
  it('estimates complexity', () => {
    expect(estimateComplexity('fix a typo in README')).toBe('low');
    expect(
      estimateComplexity('Refactor the authentication module across multiple files to use JWT tokens and add a full test suite'),
    ).toBe('high');
  });
  it('prefers coder models for coder and reasoning models for planning', () => {
    const usable = MODELS.slice(0, 3);
    const a = heuristicAssignment(usable, 'high');
    expect(a.coder).toBe('qwen2.5-coder:7b');
    expect(a.planner).toBe('deepseek-r1:14b');
  });
  it('picks the smallest capable model as router', () => {
    expect(pickRouterModel(MODELS.slice(0, 3)).name).toBe('llama3.2:3b');
    expect(pickRouterModel(MODELS.slice(0, 3), 'qwen2.5-coder:7b').name).toBe('qwen2.5-coder:7b');
  });
});

describe('routeTask', () => {
  it('uses the SLM assignment when valid', async () => {
    const client = new FakeClient(MODELS, () => ({
      content: JSON.stringify({
        complexity: 'high',
        planner: 'deepseek-r1:14b',
        coder: 'qwen2.5-coder:7b',
        reviewer: 'deepseek-r1:14b',
        fixer: 'qwen2.5-coder',
        reasoning: 'coder for code, r1 for reasoning',
      }),
    }));
    const r = await routeTask(client, 'build a REST api with auth', MODELS);
    expect(r.source).toBe('slm');
    expect(r.routerModel).toBe('llama3.2:3b');
    expect(r.assignment).toEqual({
      planner: 'deepseek-r1:14b',
      coder: 'qwen2.5-coder:7b',
      reviewer: 'deepseek-r1:14b',
      fixer: 'qwen2.5-coder:7b',
    });
    expect(r.complexity).toBe('high');
    // The router request must use structured output and must not list embedding models.
    expect(client.calls[0]!.format).toBeTypeOf('object');
    expect(client.calls[0]!.messages[0]!.content).not.toContain('nomic-embed');
  });

  it('never selects models that are not installed', async () => {
    const client = new FakeClient(MODELS, () => ({
      content: JSON.stringify({ complexity: 'low', planner: 'gpt-4o', coder: 'claude', reviewer: 'nomic-embed-text', fixer: 'llama3.2:3b', reasoning: '' }),
    }));
    const r = await routeTask(client, 'rename a variable', MODELS);
    const installed = new Set(MODELS.slice(0, 3).map((m) => m.name));
    for (const name of Object.values(r.assignment)) expect(installed.has(name)).toBe(true);
    expect(r.corrected.sort()).toEqual(['coder', 'planner', 'reviewer']);
    expect(r.assignment.fixer).toBe('llama3.2:3b');
  });

  it('falls back to heuristics when the router fails or returns garbage', async () => {
    const failing = new FakeClient(MODELS, () => {
      throw new Error('model crashed');
    });
    const r1 = await routeTask(failing, 'add a feature', MODELS);
    expect(r1.source).toBe('heuristic');
    expect(r1.reasoning).toMatch(/model crashed/);
    const garbage = new FakeClient(MODELS, () => ({ content: 'I think you should use a big model!' }));
    const r2 = await routeTask(garbage, 'add a feature', MODELS);
    expect(r2.source).toBe('heuristic');
  });

  it('short-circuits with a single installed chat model', async () => {
    const client = new FakeClient([MODELS[0]!, MODELS[3]!], () => ({ content: '' }));
    const r = await routeTask(client, 'anything', client.models);
    expect(r.source).toBe('single');
    expect(new Set(Object.values(r.assignment))).toEqual(new Set(['qwen2.5-coder:7b']));
    expect(client.calls).toHaveLength(0);
  });

  it('errors clearly with no chat models', async () => {
    const client = new FakeClient([MODELS[3]!], () => ({ content: '' }));
    await expect(routeTask(client, 'x', client.models)).rejects.toThrow(/No usable chat models/);
  });
});
