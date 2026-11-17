import { debugLog } from '../ollama/client.js';
import { parseParamsB } from '../ollama/modelProfile.js';
import type { ChatMessage, ChatRequest, ChatResult, ChatStreamHandlers, LLMClient, ModelInfo, ToolCall } from '../ollama/types.js';

export const GROQ_PREFIX = 'groq/';
export const GROQ_DEFAULT_URL = 'https://api.groq.com/openai/v1';

export class GroqError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'GroqError';
  }
}

/** Groq lists speech, TTS and safety models next to chat models; agents can only use chat models. */
const NOT_CHAT = /whisper|tts|playai|orpheus|guard|safeguard|compound/i;

export function stripGroqPrefix(name: string): string {
  return name.startsWith(GROQ_PREFIX) ? name.slice(GROQ_PREFIX.length) : name;
}

interface OpenAIMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: { id: string; type: 'function'; function: { name: string; arguments: string } }[];
  tool_call_id?: string;
}

/**
 * Convert LocalLoom's (Ollama-style) conversation to the OpenAI format: tool calls need ids,
 * and every tool result must reference the id of the call it answers.
 */
export function toOpenAIMessages(messages: ChatMessage[]): OpenAIMessage[] {
  const out: OpenAIMessage[] = [];
  let pending: string[] = [];
  messages.forEach((m, i) => {
    if (m.role === 'assistant' && m.tool_calls?.length) {
      const calls = m.tool_calls.map((c, k) => ({
        id: `call_${i}_${k}`,
        type: 'function' as const,
        function: { name: c.function.name, arguments: JSON.stringify(c.function.arguments ?? {}) },
      }));
      pending = calls.map((c) => c.id);
      out.push({ role: 'assistant', content: m.content || null, tool_calls: calls });
      return;
    }
    if (m.role === 'tool') {
      const id = pending.shift();
      // A tool result with no matching call would be rejected; pass it on as a plain message instead.
      if (id) out.push({ role: 'tool', tool_call_id: id, content: m.content });
      else out.push({ role: 'user', content: `[tool result${m.tool_name ? `: ${m.tool_name}` : ''}]\n${m.content}` });
      return;
    }
    pending = [];
    out.push({ role: m.role, content: m.content });
  });
  return out;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(t);
        const e = new Error('Aborted');
        e.name = 'AbortError';
        reject(e);
      },
      { once: true },
    );
  });
}

function parseArgs(raw: string): Record<string, unknown> {
  try {
    const v = JSON.parse(raw || '{}');
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export interface GroqClientOptions {
  apiKey: string;
  baseUrl?: string;
  /** Attempts per request when Groq rate-limits (429) or is briefly unavailable (5xx). */
  maxAttempts?: number;
  /** Longest single wait between attempts. */
  maxWaitMs?: number;
}

/** Client for Groq's OpenAI-compatible API. Model names carry a "groq/" prefix inside LocalLoom. */
export class GroqClient implements LLMClient {
  private readonly baseUrl: string;
  private readonly maxAttempts: number;
  private readonly maxWaitMs: number;

  constructor(private readonly opts: GroqClientOptions) {
    this.baseUrl = (opts.baseUrl ?? GROQ_DEFAULT_URL).replace(/\/+$/, '');
    this.maxAttempts = opts.maxAttempts ?? 4;
    this.maxWaitMs = opts.maxWaitMs ?? 60_000;
  }

  private async request(path: string, init: RequestInit, signal?: AbortSignal): Promise<Response> {
    for (let attempt = 1; ; attempt++) {
      let res: Response;
      try {
        res = await fetch(`${this.baseUrl}${path}`, {
          ...init,
          headers: { authorization: `Bearer ${this.opts.apiKey}`, 'content-type': 'application/json' },
          signal,
        });
      } catch (err) {
        if ((err as Error).name === 'AbortError') throw err;
        throw new GroqError(`Cannot reach Groq (${this.baseUrl}). Check your internet connection. (${(err as Error).message})`);
      }
      if (res.ok) return res;
      const retryable = res.status === 429 || res.status >= 500;
      if (retryable && attempt < this.maxAttempts) {
        const header = Number.parseFloat(res.headers.get('retry-after') ?? '');
        const wait = Number.isFinite(header) ? header * 1000 : 2000 * 2 ** (attempt - 1);
        await res.body?.cancel().catch(() => {});
        await sleep(Math.min(this.maxWaitMs, wait), signal);
        continue;
      }
      let body: { error?: { message?: string; code?: string; failed_generation?: string } } = {};
      try {
        body = (await res.json()) as typeof body;
      } catch {
        /* ignore */
      }
      const err = new GroqError(this.describe(res.status, body.error?.message), res.status) as GroqError & {
        toolError?: string;
        failedGeneration?: string;
      };
      // The model produced a tool call Groq refused (malformed, or a tool that was not offered). That is the
      // model's mistake, not a broken request: the agent gets told and tries again.
      const message = body.error?.message ?? '';
      if (res.status === 400 && (body.error?.code === 'tool_use_failed' || /tool call validation failed|failed to call a function/i.test(message))) {
        err.toolError = message || 'invalid tool call';
        if (typeof body.error?.failed_generation === 'string') err.failedGeneration = body.error.failed_generation;
      }
      throw err;
    }
  }

  private describe(status: number, detail?: string): string {
    if (status === 401) return 'Groq rejected the API key. Check GROQ_API_KEY.';
    if (status === 429) return `Groq rate limit reached and retries ran out${detail ? `: ${detail}` : ''}. Wait a minute, or use a local model for this agent.`;
    if (status === 413)
      return `The request is larger than your Groq plan allows per minute${detail ? ` (${detail})` : ''}. Lower LOCALLOOM_GROQ_NUM_CTX (e.g. 6000) or use a model with higher limits.`;
    if (status === 404) return `Groq does not know this model${detail ? `: ${detail}` : ''}. Run /models to refresh the list.`;
    return `Groq request failed (${status})${detail ? `: ${detail}` : ''}`;
  }

  async listModels(): Promise<ModelInfo[]> {
    const res = await this.request('/models', { method: 'GET', signal: AbortSignal.timeout(10_000) });
    const data = (await res.json()) as { data?: { id: string; active?: boolean; context_window?: number; owned_by?: string }[] };
    return (data.data ?? [])
      .filter((m) => m.active !== false && !NOT_CHAT.test(m.id))
      .map((m) => {
        const paramsB = parseParamsB('', m.id.replace(/^.*\//, ':'));
        return {
          name: `${GROQ_PREFIX}${m.id}`,
          sizeBytes: 0,
          family: m.owned_by ?? 'groq',
          parameterSize: paramsB ? `${paramsB}B` : 'cloud',
          // Unknown sizes on Groq are large hosted models.
          paramsB: paramsB || 70,
          quantization: '',
          contextLength: m.context_window ?? 8192,
          capabilities: ['completion', 'tools'],
          provider: 'groq' as const,
        };
      })
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  async chat(request: ChatRequest, handlers: ChatStreamHandlers = {}, signal?: AbortSignal): Promise<ChatResult> {
    const options = request.options ?? {};
    const body: Record<string, unknown> = {
      model: stripGroqPrefix(request.model),
      messages: toOpenAIMessages(request.messages),
      stream: true,
    };
    if (typeof options.temperature === 'number') body.temperature = options.temperature;
    if (typeof options.num_predict === 'number') body.max_completion_tokens = options.num_predict;
    if (request.tools?.length) body.tools = request.tools;
    if (request.format) body.response_format = { type: 'json_object' };

    const result: ChatResult = { content: '', thinking: '', toolCalls: [] };
    let res: Response;
    try {
      res = await this.request('/chat/completions', { method: 'POST', body: JSON.stringify(body) }, signal);
    } catch (err) {
      const { toolError, failedGeneration } = err as { toolError?: string; failedGeneration?: string };
      if (toolError === undefined) throw err;
      // Hand the raw attempt back as text: LocalLoom's text parser may still run it; otherwise the agent
      // is told what was wrong and tries again.
      result.content = (failedGeneration ?? '').trim();
      result.toolError = toolError;
      if (result.content) handlers.onContent?.(result.content);
      debugLog(request, result);
      return result;
    }
    if (!res.body) throw new GroqError('Groq returned an empty response body');

    // Some models (e.g. qwen3) put their reasoning inline in <think> tags.
    let inThink = false;
    const handleContent = (delta: string) => {
      let text = delta;
      while (text) {
        const tag = inThink ? '</think>' : '<think>';
        const at = text.indexOf(tag);
        const part = at === -1 ? text : text.slice(0, at);
        if (part) {
          if (inThink) {
            result.thinking += part;
            handlers.onThinking?.(part);
          } else {
            result.content += part;
            handlers.onContent?.(part);
          }
        }
        if (at === -1) return;
        text = text.slice(at + tag.length);
        inThink = !inThink;
      }
    };

    const partialCalls: { name: string; args: string }[] = [];
    const handleEvent = (data: string) => {
      if (data === '[DONE]') return;
      let json: {
        error?: { message?: string };
        choices?: {
          delta?: {
            content?: string | null;
            reasoning?: string | null;
            tool_calls?: { index?: number; function?: { name?: string; arguments?: string } }[];
          };
          finish_reason?: string | null;
        }[];
        x_groq?: { usage?: { prompt_tokens?: number; completion_tokens?: number } };
        usage?: { prompt_tokens?: number; completion_tokens?: number };
      };
      try {
        json = JSON.parse(data);
      } catch {
        return;
      }
      if (json.error) throw new GroqError(json.error.message ?? 'Groq stream error');
      const choice = json.choices?.[0];
      const delta = choice?.delta;
      if (delta?.reasoning) {
        result.thinking += delta.reasoning;
        handlers.onThinking?.(delta.reasoning);
      }
      if (delta?.content) handleContent(delta.content);
      for (const tc of delta?.tool_calls ?? []) {
        const i = tc.index ?? partialCalls.length;
        const call = (partialCalls[i] ??= { name: '', args: '' });
        if (tc.function?.name) call.name += tc.function.name;
        if (tc.function?.arguments) call.args += tc.function.arguments;
      }
      if (choice?.finish_reason) result.doneReason = choice.finish_reason === 'length' ? 'length' : choice.finish_reason;
      const usage = json.x_groq?.usage ?? json.usage;
      if (usage) {
        result.promptTokens = usage.prompt_tokens;
        result.outputTokens = usage.completion_tokens;
      }
    };

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    const flushLine = (line: string) => {
      const l = line.replace(/\r$/, '');
      if (l.startsWith('data:')) handleEvent(l.slice(5).trim());
    };
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let nl: number;
        while ((nl = buffer.indexOf('\n')) !== -1) {
          flushLine(buffer.slice(0, nl));
          buffer = buffer.slice(nl + 1);
        }
      }
      buffer += decoder.decode();
      if (buffer) flushLine(buffer);
    } finally {
      reader.releaseLock();
    }
    result.toolCalls = partialCalls.filter((c) => c?.name).map((c): ToolCall => ({ name: c.name, arguments: parseArgs(c.args) }));
    result.content = result.content.trim();
    debugLog(request, result);
    return result;
  }
}
