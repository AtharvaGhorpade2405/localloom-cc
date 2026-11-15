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

/** Drop exact duplicate calls within one reply (models sometimes emit the same edit twice). */
export function dedupeCalls(calls: ToolCall[]): ToolCall[] {
  const seen = new Set<string>();
  return calls.filter((c) => {
    const sig = signature(c);
    if (seen.has(sig)) return false;
    seen.add(sig);
    return true;
  });
}

/**
 * When one reply contains several line-range edits to the same file, the model numbered all of them
 * against the file as it read it. Applying them bottom-up keeps those numbers valid.
 */
export function orderEdits(calls: ToolCall[]): ToolCall[] {
  const isLineEdit = (c: ToolCall) => getTool(c.name)?.name === 'edit_file' && c.arguments.start_line !== undefined;
  const byPath = new Map<string, number[]>();
  calls.forEach((c, i) => {
    if (!isLineEdit(c)) return;
    const key = String(c.arguments.path ?? c.arguments.file_path ?? '');
    byPath.set(key, [...(byPath.get(key) ?? []), i]);
  });
  const out = [...calls];
  for (const idx of byPath.values()) {
    if (idx.length < 2) continue;
    const sorted = idx.map((i) => calls[i]!).sort((a, b) => Number(b.arguments.start_line) - Number(a.arguments.start_line));
    idx.forEach((slot, k) => (out[slot] = sorted[k]!));
  }
  return out;
}

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
  const writes = agent.tools.includes('write_file');
  const fileBlocks = `How to change files:
- EXISTING files: always edit them in place and change ONLY the lines that need to change. Never rewrite a whole existing file (that is blocked).
  The easiest way is by line number, using the numbers shown by read_file:
<edit_file path="relative/path.py" lines="12-15">
<new>
the new lines that replace lines 12 to 15
</new>
</edit_file>
  To insert lines without removing any, replace the line just before them with that same line followed by the new lines.
  You can also quote exactly what to replace: <edit_file path="relative/path.py"><old>exact existing lines</old><new>replacement</new></edit_file>
- After each edit you get the updated region with current line numbers; use those for the next edit.
- NEW files only: write the complete content (no JSON, no escaping):
<write_file path="relative/new_file.py">
...complete file content...
</write_file>`;
  if (!nativeTools) {
    system += `\n\n## Tools
You can use these tools:
${toolDocs(agent.tools)}

To call a tool, reply with ONLY a JSON object, for example:
{"name": "read_file", "arguments": {"path": "src/index.ts"}}
${writes ? `\n${fileBlocks}\n` : ''}
Call one tool per reply. You will then receive the result. When you are finished, reply in plain text without any tool call.`;
  } else if (writes) {
    // Even tool-capable small models mangle code when they must escape it inside JSON arguments.
    system += `\n\n## Writing code
You may call the edit_file / write_file tools, or use the raw block format below, which is more reliable for code:
${fileBlocks}`;
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
    let parseErrors: string[] = [];
    if (!calls.length) {
      const parsed = parseTextToolCalls(result.content, isKnownTool);
      parseErrors = parsed.errors;
      if (parsed.calls.length || parsed.errors.length) {
        calls = parsed.calls;
        prose = parsed.rest;
        textProtocol = true;
      }
    }
    if (prose.trim()) {
      lastContent = prose;
      emit({ type: 'agent:message', agent: agent.role, model: model.name, content: prose });
    }
    if (parseErrors.length) {
      emit({ type: 'notice', level: 'warn', text: `${agent.label}: malformed tool call — asking the model to retry.` });
    }

    if (!calls.length && parseErrors.length) {
      // The model tried to call a tool but we could not understand it: tell it, never fail silently.
      messages.push({ role: 'assistant', content: result.content });
      messages.push({ role: 'user', content: `[tool error]\n${parseErrors.join('\n')}\nPlease try again.` });
      continue;
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

    calls = orderEdits(dedupeCalls(calls));
    for (const call of calls) {
      throwIfAborted(signal);
      const id = `t${++toolSeq}`;
      const def = getTool(call.name);
      const detail = def ? def.describe(call.arguments) : '';
      emit({ type: 'tool:start', agent: agent.role, id, name: def?.name ?? call.name, detail });
      const sig = signature(call);
      const repeats = (seen.get(sig) ?? 0) + 1;
      seen.set(sig, repeats);
      const res =
        repeats >= 3 && def && (def.name === 'edit_file' || def.name === 'write_file')
          ? {
              name: def.name,
              args: call.arguments,
              ok: false,
              output: `Skipped: you already made this exact change ${repeats - 1} times. Repeating it does nothing. Read the file to see its current state, then make a DIFFERENT change or finish.`,
              summary: 'skipped: repeated identical change',
            }
          : await executeTool(call.name, call.arguments, toolContext, agent.tools);
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
        else if (n >= 2 && res.name === 'edit_file') {
          output += `

WARNING: edit_file has now failed ${n} times the same way. Stop quoting old text: use the line numbers from read_file instead (edit_file with start_line, end_line and new_string, or an <edit_file path="..." lines="a-b"> block). Do not rewrite the whole file.`;
        } else if (n >= 2) {
          output += `\n\nWARNING: this exact failure has now happened ${n} times. Your previous fix did not work. Read the error message carefully and reconsider the root cause — it is often in a DIFFERENT file than the one you keep editing (e.g. a missing export, wrong import style, wrong path). Change your approach.`;
        }
      }
      if (textProtocol) {
        messages.push({ role: 'user', content: `[tool result: ${res.name}]\n${output}` });
      } else {
        messages.push({ role: 'tool', content: output, tool_name: res.name });
      }
    }
    if (parseErrors.length) {
      messages.push({ role: 'user', content: `[tool error]\n${parseErrors.join('\n')}` });
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
