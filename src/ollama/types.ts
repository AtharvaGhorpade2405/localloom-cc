import { z } from 'zod';

export const ModelDetailsSchema = z
  .object({
    format: z.string().optional(),
    family: z.string().optional(),
    families: z.array(z.string()).nullable().optional(),
    parameter_size: z.string().optional(),
    quantization_level: z.string().optional(),
    context_length: z.number().optional(),
  })
  .passthrough();

export const TagModelSchema = z
  .object({
    name: z.string(),
    model: z.string().optional(),
    size: z.number().optional().default(0),
    modified_at: z.string().optional(),
    digest: z.string().optional(),
    details: ModelDetailsSchema.optional(),
    capabilities: z.array(z.string()).optional(),
  })
  .passthrough();

export const TagsResponseSchema = z.object({ models: z.array(TagModelSchema).default([]) });

export const ShowResponseSchema = z
  .object({
    capabilities: z.array(z.string()).optional(),
    model_info: z.record(z.string(), z.unknown()).optional(),
    details: ModelDetailsSchema.optional(),
  })
  .passthrough();

export const ToolCallSchema = z.object({
  function: z.object({
    name: z.string(),
    arguments: z.union([z.record(z.string(), z.unknown()), z.string()]).optional(),
  }),
});

export const ChatChunkSchema = z
  .object({
    model: z.string().optional(),
    message: z
      .object({
        role: z.string().optional(),
        content: z.string().optional().default(''),
        thinking: z.string().optional(),
        tool_calls: z.array(ToolCallSchema).optional(),
      })
      .optional(),
    done: z.boolean().optional().default(false),
    done_reason: z.string().optional(),
    error: z.string().optional(),
    prompt_eval_count: z.number().optional(),
    eval_count: z.number().optional(),
  })
  .passthrough();

/** A normalized, installed model as LocalLoom sees it. */
export interface ModelInfo {
  name: string;
  sizeBytes: number;
  family: string;
  parameterSize: string;
  /** Parameter count in billions (best effort, 0 if unknown). */
  paramsB: number;
  quantization: string;
  contextLength: number;
  capabilities: string[];
  /** Where the model runs. Undefined means a local Ollama model. */
  provider?: 'ollama' | 'groq';
}

/** True for models that run on a remote API (code and prompts leave the machine). */
export function isRemote(model: ModelInfo): boolean {
  return !!model.provider && model.provider !== 'ollama';
}

export type ChatRole = 'system' | 'user' | 'assistant' | 'tool';

export interface ToolCall {
  name: string;
  arguments: Record<string, unknown>;
}

export interface ChatMessage {
  role: ChatRole;
  content: string;
  tool_calls?: { function: { name: string; arguments: Record<string, unknown> } }[];
  tool_name?: string;
}

export interface ToolSpec {
  type: 'function';
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  tools?: ToolSpec[];
  /** 'json' or a JSON schema for structured output. */
  format?: 'json' | Record<string, unknown>;
  think?: boolean;
  options?: { temperature?: number; num_ctx?: number; [k: string]: unknown };
  keepAlive?: string;
}

export interface ChatStreamHandlers {
  onContent?: (delta: string) => void;
  onThinking?: (delta: string) => void;
}

export interface ChatResult {
  content: string;
  thinking: string;
  toolCalls: ToolCall[];
  doneReason?: string;
  /** The backend refused the model's tool call (the reply carries no usable call). */
  toolError?: string;
  promptTokens?: number;
  outputTokens?: number;
}

/** Abstraction over the LLM backend so agents and the router can be tested with fakes. */
export interface LLMClient {
  listModels(): Promise<ModelInfo[]>;
  chat(request: ChatRequest, handlers?: ChatStreamHandlers, signal?: AbortSignal): Promise<ChatResult>;
}
