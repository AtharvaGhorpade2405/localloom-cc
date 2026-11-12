import type { ModelInfo } from './types.js';

/** Parse "7.6B", "770M", "1.5b" → billions. Falls back to a size hint in the model name (e.g. "llama3:8b"). */
export function parseParamsB(parameterSize: string, name = ''): number {
  const from = (s: string): number => {
    const m = /(\d+(?:\.\d+)?)\s*([bmk])\b/i.exec(s);
    if (!m) return 0;
    const n = Number.parseFloat(m[1]!);
    const unit = m[2]!.toLowerCase();
    return unit === 'b' ? n : unit === 'm' ? n / 1000 : n / 1_000_000;
  };
  return from(parameterSize) || from(name.replace(/^.*?:/, ' ')) || 0;
}

const CODER_PATTERNS = [
  /coder/i,
  /code(?!x)/i,
  /codestral/i,
  /starcoder/i,
  /devstral/i,
  /deepseek-v[23]/i,
  /granite.*code/i,
  /codegemma/i,
  /qwen3-coder/i,
  /gpt-oss/i,
];
const REASONING_PATTERNS = [
  /deepseek-r1/i,
  /qwq/i,
  /qwen3/i,
  /reason/i,
  /think/i,
  /phi4/i,
  /magistral/i,
  /gpt-oss/i,
  /r1\b/i,
];

export interface ModelProfile {
  coding: boolean;
  reasoning: boolean;
  embedding: boolean;
  tools: boolean;
  thinking: boolean;
  vision: boolean;
}

export function profileModel(model: ModelInfo): ModelProfile {
  const caps = new Set(model.capabilities.map((c) => c.toLowerCase()));
  const id = `${model.name} ${model.family}`;
  const embedding = caps.has('embedding') || /embed|bge|minilm|nomic-embed/i.test(id) || !caps.has('completion');
  return {
    coding: CODER_PATTERNS.some((p) => p.test(model.name)),
    reasoning: caps.has('thinking') || REASONING_PATTERNS.some((p) => p.test(model.name)),
    embedding,
    tools: caps.has('tools'),
    thinking: caps.has('thinking'),
    vision: caps.has('vision'),
  };
}

/** Models able to act as a chat agent (excludes embedding-only models). */
export function usableModels(models: ModelInfo[]): ModelInfo[] {
  return models.filter((m) => !profileModel(m).embedding);
}

export function formatBytes(bytes: number): string {
  if (!bytes) return '—';
  const gb = bytes / 1024 ** 3;
  if (gb >= 1) return `${gb.toFixed(1)} GB`;
  return `${(bytes / 1024 ** 2).toFixed(0)} MB`;
}

export function describeModel(model: ModelInfo): string {
  const p = profileModel(model);
  const tags = [
    p.coding && 'coding',
    p.reasoning && 'reasoning',
    p.tools && 'tools',
    p.vision && 'vision',
  ].filter(Boolean);
  return [model.parameterSize || '?', model.family, tags.join('/')].filter(Boolean).join(' · ');
}

/** Resolve a user/model-supplied name to an installed model (tolerates a missing ":latest" tag and case). */
export function resolveModelName(name: string, models: ModelInfo[]): ModelInfo | undefined {
  const wanted = name.trim().toLowerCase();
  if (!wanted) return undefined;
  const exact = models.find((m) => m.name.toLowerCase() === wanted);
  if (exact) return exact;
  const withLatest = models.find((m) => m.name.toLowerCase() === `${wanted}:latest`);
  if (withLatest) return withLatest;
  const noLatest = models.find((m) => m.name.toLowerCase().replace(/:latest$/, '') === wanted.replace(/:latest$/, ''));
  return noLatest;
}
