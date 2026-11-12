import type { LocalLoomConfig } from '../config.js';
import { profileModel } from '../ollama/modelProfile.js';
import type { ChatMessage, LLMClient, ModelInfo, ToolCall } from '../ollama/types.js';
import { executeTool, getTool, toolDocs, toolSpecs, type ToolContext } from '../tools/registry.js';
import type { AgentDefinition } from './definitions.js';
import type { EmitFn } from './events.js';
import { parseTextToolCalls } from './toolParse.js';

export interface RunAgentOptions {
  agent: AgentDefinition;
  model: ModelInfo;
  prompt: string;
  client: LLMClient;
  config: LocalLoomConfig;
  toolContext: ToolContext;
  emit: EmitFn;
  signal?: AbortSignal;
  /** Called with the agent's final reply; return a nudge message to make the agent continue. */
  checkFinal?: (content: string, stats: AgentRunStats) => string | undefined;
  maxSteps?: number;
}

export interface AgentRunStats {
  toolCalls: number;
  mutatingCalls: number;
  failedCalls: number;
  steps: number;
  /** True when the turn ended early because the agent kept hitting the same failure. */
  stuck?: boolean;
}

export interface AgentRunResult {
  content: string;
  stats: AgentRunStats;
}

export class CancelledError extends Error {
  constructor() {
    super('Cancelled');
    this.name = 'CancelledError';
  }
}

let toolSeq = 0;

/** Identical failures tolerated before an agent's turn is ended early. */
export const STUCK_LIMIT = 4;

function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw new CancelledError();
}

/** Keep the conversation within the context budget by eliding the oldest tool outputs. */
export function compactMessages(messages: ChatMessage[], budgetChars: number): void {
  const size = () => messages.reduce((n, m) => n + m.content.length + 20, 0);
  if (size() <= budgetChars) return;
  // Never touch the system prompt (0), the task prompt (1) or the last 4 messages.
  for (let i = 2; i < messages.length - 4 && size() > budgetChars; i++) {
    const m = messages[i]!;
    const isToolResult = m.role === 'tool' || (m.role === 'user' && m.content.startsWith('[tool result'));
    if (isToolResult && m.content.length > 300) {
      m.content = `${m.content.slice(0, 200)}\n… [older tool output elided to save context]`;
    }
  }
  for (let i = 2; i < messages.length - 4 && size() > budgetChars; i++) {
    const m = messages[i]!;
    if (m.role === 'assistant' && m.content.length > 400) {
      m.content = `${m.content.slice(0, 300)}\n… [elided]`;
    }
  }
}

function signature(call: ToolCall): string {
  return `${call.name}:${JSON.stringify(call.arguments)}`;
}

export async function runAgent(opts: RunAgentOptions): Promise<AgentRunResult> {
  const { agent, model, client, config, emit, signal, toolContext } = opts;
  const maxSteps = opts.maxSteps ?? config.maxAgentSteps;
  const profile = profileModel(model);
  const nativeTools = profile.tools;
  const numCtx = Math.max(2048, Math.min(config.numCtx, model.contextLength || config.numCtx));
  const budgetChars = Math.floor(numCtx * 3);
  const isKnownTool = (name: string) => !!getTool(name);

  let system = agent.system;
  if (!nativeTools) {
    system += `\n\n## Tools
You can use these tools:
${toolDocs(agent.tools)}

To call a tool, reply with ONLY a JSON object and nothing else, for example:
{"name": "read_file", "arguments": {"path": "src/index.ts"}}
Call one tool per reply. You will then receive the result. When you are finished, reply in plain text without any tool JSON.`;
  }

  const messages: ChatMessage[] = [
    { role: 'system', content: system },
    { role: 'user', content: opts.prompt },
  ];
  const stats: AgentRunStats = { toolCalls: 0, mutatingCalls: 0, failedCalls: 0, steps: 0 };
  const seen = new Map<string, number>();
  // Identical failing results (e.g. the same test error) signal the agent is going in circles.
  const failures = new Map<string, number>();
  let stuckOutput: string | undefined;
  let nudges = 0;
  let lastContent = '';

  const chatOnce = async (withTools: boolean) => {
    throwIfAborted(signal);
    compactMessages(messages, budgetChars);
    try {
      return await client.chat(
        {
          model: model.name,
          messages,
          tools: withTools && nativeTools ? toolSpecs(agent.tools) : undefined,
          think: profile.thinking ? true : undefined,
          options: { temperature: 0.2, num_ctx: numCtx },
          keepAlive: '10m',
        },
        {
          onContent: (delta) => emit({ type: 'agent:content', agent: agent.role, delta }),
          onThinking: (delta) => emit({ type: 'agent:thinking', agent: agent.role, delta }),
        },
        signal,
      );
    } catch (err) {
      if (signal?.aborted || (err as Error).name === 'AbortError') throw new CancelledError();
      throw err;
    }
  };

  for (let step = 1; step <= maxSteps; step++) {
    stats.steps = step;
    emit({ type: 'agent:step', agent: agent.role, step, maxSteps });
    const result = await chatOnce(true);
    let calls = result.toolCalls;
    let prose = result.content;
    let textProtocol = false;
    if (!calls.length) {
      const parsed = parseTextToolCalls(result.content, isKnownTool);
      if (parsed.calls.length) {
        calls = parsed.calls;
        prose = parsed.rest;
        textProtocol = true;
      }
    }
    if (prose.trim()) {
      lastContent = prose;
      emit({ type: 'agent:message', agent: agent.role, model: model.name, content: prose });
    }

    if (!calls.length) {
      const nudge = opts.checkFinal?.(result.content, stats);
      if (nudge && nudges < 2) {
        nudges++;
        messages.push({ role: 'assistant', content: result.content });
        messages.push({ role: 'user', content: nudge });
        continue;
      }
      return { content: result.content, stats };
    }

    if (textProtocol) {
      messages.push({ role: 'assistant', content: result.content });
    } else {
      messages.push({
        role: 'assistant',
        content: result.content,
        tool_calls: calls.map((c) => ({ function: { name: c.name, arguments: c.arguments } })),
      });
    }

    for (const call of calls) {
      throwIfAborted(signal);
      const id = `t${++toolSeq}`;
      const def = getTool(call.name);
      const detail = def ? def.describe(call.arguments) : '';
      emit({ type: 'tool:start', agent: agent.role, id, name: def?.name ?? call.name, detail });
      const sig = signature(call);
      const repeats = (seen.get(sig) ?? 0) + 1;
      seen.set(sig, repeats);
      const res = await executeTool(call.name, call.arguments, toolContext, agent.tools);
      throwIfAborted(signal);
      stats.toolCalls++;
      if (!res.ok) stats.failedCalls++;
      if (res.ok && def && !def.readOnly) stats.mutatingCalls++;
      emit({ type: 'tool:end', agent: agent.role, id, name: res.name, detail, ok: res.ok, summary: res.summary });
      let output = res.output;
      if (repeats >= 3) {
        output += `\n\nNote: you have made this exact call ${repeats} times. Do not repeat it — move on to the next step or finish.`;
      }
      if (!res.ok) {
        // Ignore timings so "same error, different duration" still counts as the same failure.
        const key = `${res.name}:${res.output.replace(/\d+(\.\d+)?\s?m?s\b/g, '').slice(0, 2000)}`;
        const n = (failures.get(key) ?? 0) + 1;
        failures.set(key, n);
        if (n >= STUCK_LIMIT) stuckOutput = res.output;
        else if (n >= 2) {
          output += `\n\nWARNING: this exact failure has now happened ${n} times. Your previous fix did not work. Read the error message carefully and reconsider the root cause — it is often in a DIFFERENT file than the one you keep editing (e.g. a missing export, wrong import style, wrong path). Change your approach.`;
        }
      }
      if (textProtocol) {
        messages.push({ role: 'user', content: `[tool result: ${res.name}]\n${output}` });
      } else {
        messages.push({ role: 'tool', content: output, tool_name: res.name });
      }
    }
    if (stuckOutput !== undefined) {
      emit({
        type: 'notice',
        level: 'warn',
        text: `${agent.label} hit the same failure ${STUCK_LIMIT} times; ending its turn so the next agent can take a fresh look.`,
      });
      const content = `${lastContent ? `${lastContent}\n\n` : ''}I got stuck: the same failure repeated ${STUCK_LIMIT} times and my fixes did not resolve it. Last failing output:\n${stuckOutput.slice(0, 1500)}`;
      return { content, stats: { ...stats, stuck: true } };
    }
  }

  // Step budget exhausted: ask for a final summary without tools.
  emit({ type: 'notice', level: 'warn', text: `${agent.label} reached its step limit (${maxSteps}); asking for a summary.` });
  messages.push({
    role: 'user',
    content: 'You have reached the maximum number of steps. Do not call any more tools. Summarize what you completed and what remains.',
  });
  const final = await chatOnce(false);
  const content = parseTextToolCalls(final.content, isKnownTool).rest || final.content || lastContent;
  if (content.trim()) emit({ type: 'agent:message', agent: agent.role, model: model.name, content });
  return { content, stats };
}
