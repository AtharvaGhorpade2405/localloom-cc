import { GROQ_PREFIX } from '../groq/client.js';
import type { ChatRequest, ChatResult, ChatStreamHandlers, LLMClient, ModelInfo } from '../ollama/types.js';

/**
 * Puts local Ollama models and remote Groq models behind one client: models are listed together,
 * and each chat request goes to the backend that owns the model ("groq/…" names go to Groq).
 */
export class MultiClient implements LLMClient {
  /** Why the remote model list could not be loaded the last time (shown to the user). */
  remoteError?: string;

  constructor(
    readonly local: LLMClient,
    readonly remote?: LLMClient,
  ) {}

  async listModels(): Promise<ModelInfo[]> {
    // Local models are required; a remote failure (offline, bad key) must not break local use.
    const [local, remote] = await Promise.all([
      this.local.listModels(),
      this.remote
        ? this.remote.listModels().then(
            (m) => {
              this.remoteError = undefined;
              return m;
            },
            (err: Error) => {
              this.remoteError = err.message;
              return [] as ModelInfo[];
            },
          )
        : Promise.resolve([] as ModelInfo[]),
    ]);
    return [...local, ...remote];
  }

  chat(request: ChatRequest, handlers?: ChatStreamHandlers, signal?: AbortSignal): Promise<ChatResult> {
    if (request.model.startsWith(GROQ_PREFIX)) {
      if (!this.remote) throw new Error(`${request.model} needs Groq, but GROQ_API_KEY is not set.`);
      return this.remote.chat(request, handlers, signal);
    }
    return this.local.chat(request, handlers, signal);
  }
}
