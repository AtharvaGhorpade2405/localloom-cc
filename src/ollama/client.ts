import fs from 'node:fs';
import {
  ChatChunkSchema,
  ShowResponseSchema,
  TagsResponseSchema,
  type ChatRequest,
  type ChatResult,
  type ChatStreamHandlers,
  type LLMClient,
  type ModelInfo,
  type ToolCall,
} from './types.js';
import { parseParamsB } from './modelProfile.js';

/** When LOCALLOOM_DEBUG_LOG is set, append every model exchange to that file (JSON lines). */
export function debugLog(request: ChatRequest, result: ChatResult): void {
  const file = process.env.LOCALLOOM_DEBUG_LOG;
  if (!file) return;
  try {
    const entry = {
      time: new Date().toISOString(),
      model: request.model,
      tools: request.tools?.map((t) => t.function.name),
      messages: request.messages,
      response: { content: result.content, thinking: result.thinking, toolCalls: result.toolCalls, doneReason: result.doneReason },
    };
    fs.appendFileSync(file, `${JSON.stringify(entry)}\n`);
  } catch {
    /* never let logging break a run */
  }
}

export class OllamaError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'OllamaError';
  }
}

function parseArgs(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw as Record<string, unknown>;
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') return parsed as Record<string, unknown>;
    } catch {
      /* fall through */
    }
  }
  return {};
}

/** Strip <think>…</think> blocks that some reasoning models inline into content. */
export function stripThinkTags(text: string): string {
  return text.replace(/<think>[\s\S]*?(<\/think>|$)/g, '').replace(/^\s+/, '');
}

export class OllamaClient implements LLMClient {
  private showCache = new Map<string, { capabilities: string[]; contextLength: number }>();

  constructor(readonly host: string) {}

  private async request(path: string, init: RequestInit & { timeoutMs?: number } = {}): Promise<Response> {
    const { timeoutMs, signal, ...rest } = init;
    const signals: AbortSignal[] = [];
    if (signal) signals.push(signal);
    if (timeoutMs) signals.push(AbortSignal.timeout(timeoutMs));
    let res: Response;
    try {
      res = await fetch(`${this.host}${path}`, {
        ...rest,
        headers: { 'content-type': 'application/json', ...(rest.headers ?? {}) },
        signal: signals.length ? AbortSignal.any(signals) : undefined,
      });
    } catch (err) {
      if ((err as Error).name === 'AbortError' && signal?.aborted) throw err;
      throw new OllamaError(
        `Cannot reach Ollama at ${this.host}. Is it running? Start it with \`ollama serve\`. (${(err as Error).message})`,
      );
    }
    if (!res.ok) {
      let detail = '';
      try {
        const body = (await res.json()) as { error?: string };
        detail = body.error ?? '';
      } catch {
        /* ignore */
      }
      throw new OllamaError(`Ollama ${path} failed (${res.status})${detail ? `: ${detail}` : ''}`, res.status);
    }
    return res;
  }

  async ping(): Promise<boolean> {
    try {
      await this.request('/api/version', { timeoutMs: 3000 });
      return true;
    } catch {
      return false;
    }
  }

  private async show(name: string): Promise<{ capabilities: string[]; contextLength: number }> {
    const cached = this.showCache.get(name);
    if (cached) return cached;
    const res = await this.request('/api/show', {
      method: 'POST',
      body: JSON.stringify({ model: name }),
      timeoutMs: 10000,
    });
    const data = ShowResponseSchema.parse(await res.json());
    let contextLength = 0;
    for (const [key, value] of Object.entries(data.model_info ?? {})) {
      if (key.endsWith('.context_length') && typeof value === 'number') contextLength = value;
    }
    const info = { capabilities: data.capabilities ?? [], contextLength };
    this.showCache.set(name, info);
    return info;
  }

  async listModels(): Promise<ModelInfo[]> {
    const res = await this.request('/api/tags', { timeoutMs: 8000 });
    const data = TagsResponseSchema.parse(await res.json());
    const models = await Promise.all(
      data.models.map(async (m): Promise<ModelInfo> => {
        let capabilities = m.capabilities;
        let contextLength = m.details?.context_length ?? 0;
        if (!capabilities || !contextLength) {
          // Older Ollama versions don't include these in /api/tags.
          try {
            const shown = await this.show(m.name);
            capabilities = capabilities ?? shown.capabilities;
            contextLength = contextLength || shown.contextLength;
          } catch {
            /* best effort */
          }
        }
        const parameterSize = m.details?.parameter_size ?? '';
        return {
          name: m.name,
          sizeBytes: m.size ?? 0,
          family: m.details?.family ?? '',
          parameterSize,
          paramsB: parseParamsB(parameterSize, m.name),
          quantization: m.details?.quantization_level ?? '',
          contextLength: contextLength || 4096,
          capabilities: capabilities ?? ['completion'],
        };
      }),
    );
    return models.sort((a, b) => a.name.localeCompare(b.name));
  }

  async chat(request: ChatRequest, handlers: ChatStreamHandlers = {}, signal?: AbortSignal): Promise<ChatResult> {
    const body: Record<string, unknown> = {
      model: request.model,
      messages: request.messages,
      stream: true,
      options: request.options ?? {},
    };
    if (request.tools?.length) body.tools = request.tools;
    if (request.format) body.format = request.format;
    if (request.think !== undefined) body.think = request.think;
    if (request.keepAlive) body.keep_alive = request.keepAlive;

    const res = await this.request('/api/chat', { method: 'POST', body: JSON.stringify(body), signal });
    if (!res.body) throw new OllamaError('Ollama returned an empty response body');

    const result: ChatResult = { content: '', thinking: '', toolCalls: [] };
    const decoder = new TextDecoder();
    let buffer = '';
    // Track an inline <think> section so it is routed to onThinking instead of content.
    let inThink = false;

    const handleContent = (delta: string) => {
      let text = delta;
      while (text.length) {
        if (inThink) {
          const end = text.indexOf('</think>');
          if (end === -1) {
            result.thinking += text;
            handlers.onThinking?.(text);
            return;
          }
          const part = text.slice(0, end);
          result.thinking += part;
          if (part) handlers.onThinking?.(part);
          text = text.slice(end + '</think>'.length);
          inThink = false;
        } else {
          const start = text.indexOf('<think>');
          if (start === -1) {
            result.content += text;
            handlers.onContent?.(text);
            return;
          }
          const part = text.slice(0, start);
          if (part) {
            result.content += part;
            handlers.onContent?.(part);
          }
          text = text.slice(start + '<think>'.length);
          inThink = true;
        }
      }
    };

    const handleLine = (line: string) => {
      if (!line.trim()) return;
      let json: unknown;
      try {
        json = JSON.parse(line);
      } catch {
        return;
      }
      const chunk = ChatChunkSchema.parse(json);
      if (chunk.error) throw new OllamaError(chunk.error);
      const msg = chunk.message;
      if (msg) {
        if (msg.thinking) {
          result.thinking += msg.thinking;
          handlers.onThinking?.(msg.thinking);
        }
        if (msg.content) handleContent(msg.content);
        if (msg.tool_calls) {
          for (const tc of msg.tool_calls) {
            const call: ToolCall = { name: tc.function.name, arguments: parseArgs(tc.function.arguments) };
            result.toolCalls.push(call);
          }
        }
      }
      if (chunk.done) {
        result.doneReason = chunk.done_reason;
        result.promptTokens = chunk.prompt_eval_count;
        result.outputTokens = chunk.eval_count;
      }
    };

    const reader = res.body.getReader();
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let nl: number;
        while ((nl = buffer.indexOf('\n')) !== -1) {
          handleLine(buffer.slice(0, nl));
          buffer = buffer.slice(nl + 1);
        }
      }
      buffer += decoder.decode();
      if (buffer) handleLine(buffer);
    } finally {
      reader.releaseLock();
    }
    result.content = result.content.trim();
    debugLog(request, result);
    return result;
  }
}
