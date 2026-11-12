import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ChatRequest, ChatResult, ChatStreamHandlers, LLMClient, ModelInfo, ToolCall } from '../src/ollama/types.js';

export function tmpDir(prefix = 'localloom-test-'): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function model(name: string, opts: Partial<ModelInfo> = {}): ModelInfo {
  return {
    name,
    sizeBytes: 4.7e9,
    family: 'qwen2',
    parameterSize: '7.6B',
    paramsB: 7.6,
    quantization: 'Q4_K_M',
    contextLength: 32768,
    capabilities: ['completion', 'tools'],
    ...opts,
  };
}

export type Responder = (req: ChatRequest, callIndex: number) => Partial<ChatResult> & { content?: string; toolCalls?: ToolCall[] };

/** Scripted fake LLM: streams the returned content word by word. */
export class FakeClient implements LLMClient {
  calls: ChatRequest[] = [];
  constructor(
    public models: ModelInfo[],
    private responder: Responder,
  ) {}
  async listModels() {
    return this.models;
  }
  async chat(req: ChatRequest, handlers: ChatStreamHandlers = {}, signal?: AbortSignal): Promise<ChatResult> {
    if (signal?.aborted) {
      const e = new Error('aborted');
      e.name = 'AbortError';
      throw e;
    }
    this.calls.push(JSON.parse(JSON.stringify(req)));
    const r = this.responder(req, this.calls.length - 1);
    const content = r.content ?? '';
    for (const piece of content.match(/\S+\s*/g) ?? []) handlers.onContent?.(piece);
    return { content, thinking: '', toolCalls: r.toolCalls ?? [] };
  }
}

export function roleOf(req: ChatRequest): string {
  const sys = req.messages[0]?.content ?? '';
  const m = /You are the (PLANNER|CODER|REVIEWER|FIXER)/.exec(sys);
  return m ? m[1]!.toLowerCase() : 'router';
}
