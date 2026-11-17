import { createHash } from 'node:crypto';
import fs from 'node:fs';
import type { LocalLoomConfig } from '../config.js';
import { profileModel } from '../ollama/modelProfile.js';
import { isRemote, type ChatMessage, type ChatResult, type LLMClient, type ModelInfo, type ToolCall } from '../ollama/types.js';
import { isDegenerate } from './degenerate.js';
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
/** Unusable replies in a row (garbled output, unparseable tool calls) before the turn is ended. */
export const BAD_REPLY_LIMIT = 3;
/** Failed write/edit attempts in a row (whatever the error) before the turn is ended. */
export const FAILED_EDIT_LIMIT = 6;
/** Times the exact same call may be made before the turn is ended. */
export const REPEAT_LIMIT = 5;

/** Identity of a file's current content, to notice when edits keep returning it to an earlier state. */
function fileState(ctx: ToolContext, p: unknown): { key: string; rel: string } | undefined {
  if (typeof p !== 'string') return undefined;
  try {
    const abs = ctx.workspace.resolve(p);
    const rel = ctx.workspace.relative(abs);
    const hash = createHash('sha1').update(fs.readFileSync(abs)).digest('hex');
    return { key: `${rel}:${hash}`, rel };
  } catch {
    return undefined;
  }
}

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
  const ctxLimit = isRemote(model) ? config.groqNumCtx : config.numCtx;
  const numCtx = Math.max(2048, Math.min(ctxLimit, model.contextLength || ctxLimit));
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
  } else if (writes && isRemote(model)) {
    // Hosted APIs validate tool calls against the tools sent, so file tools stay native for them.
    system += `\n\n## Writing code
Create and change files with the write_file and edit_file tools. You may also write the block format below directly in your reply:
${fileBlocks}`;
  } else if (writes) {
    // Even tool-capable small models mangle code when they must escape it inside JSON arguments.
    system += `\n\n## Writing code
To create or change files, do NOT use a tool call. Write the block format below directly in your reply (the user watches the file being written live). Use tool calls for everything else (reading, searching, commands).
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
  /** Set when the agent is clearly going in circles; ends the turn after the current reply. */
  let loopReason: string | undefined;
  let nudges = 0;
  let lastContent = '';

  // Local models write file content as streamed raw blocks, not native tool-call arguments: those
  // arrive in one piece (nothing to show while the file is being written) and get mangled by JSON escaping.
  // Hosted models (Groq) keep every tool: the API rejects calls to tools that were not sent, and large
  // models escape JSON reliably.
  const nativeSpecs = toolSpecs(isRemote(model) ? agent.tools : agent.tools.filter((t) => t !== 'write_file' && t !== 'edit_file'));
  // A single reply never needs more than this; without a cap a runaway model generates until the context is full.
  const numPredict = Math.max(1024, Math.min(8192, Math.floor(numCtx / 2)));

  const chatOnce = async (withTools: boolean): Promise<ChatResult & { degenerate?: boolean }> => {
    throwIfAborted(signal);
    compactMessages(messages, budgetChars);
    // Our own abort handle, so a reply that collapses into repetition can be cut off mid-stream.
    const ac = new AbortController();
    const onAbort = () => ac.abort();
    signal?.addEventListener('abort', onAbort, { once: true });
    let streamed = '';
    let checkedAt = 0;
    let degenerate = false;
    try {
      const result = await client.chat(
        {
          model: model.name,
          messages,
          tools: withTools && nativeTools ? nativeSpecs : undefined,
          think: profile.thinking ? true : undefined,
          options: { temperature: 0.2, num_ctx: numCtx, num_predict: numPredict },
          keepAlive: '10m',
        },
        {
          onContent: (delta) => {
            streamed += delta;
            if (!degenerate && streamed.length - checkedAt >= 400) {
              checkedAt = streamed.length;
              if (isDegenerate(streamed)) {
                degenerate = true;
                ac.abort();
              }
            }
            emit({ type: 'agent:content', agent: agent.role, delta });
          },
          onThinking: (delta) => emit({ type: 'agent:thinking', agent: agent.role, delta }),
        },
        ac.signal,
      );
      return { ...result, degenerate: degenerate || isDegenerate(result.content) };
    } catch (err) {
      if (degenerate && !signal?.aborted) return { content: streamed, thinking: '', toolCalls: [], degenerate: true };
      if (signal?.aborted || (err as Error).name === 'AbortError') throw new CancelledError();
      throw err;
    } finally {
      signal?.removeEventListener('abort', onAbort);
    }
  };

  /** End the turn early with an explanation, so the pipeline moves on instead of looping. */
  const giveUp = (why: string, userHint = ''): AgentRunResult => {
    emit({ type: 'notice', level: 'warn', text: `${agent.label} stopped: ${why}${userHint ? ` ${userHint}` : ''}` });
    return {
      content: `${lastContent ? `${lastContent}\n\n` : ''}I got stuck: ${why}`,
      stats: { ...stats, stuck: true },
    };
  };
  /** Replies in a row that could not be used at all (garbled, or tool calls that would not parse). */
  let badReplies = 0;
  /** Failed write/edit attempts since the last one that worked. */
  let failedMutations = 0;
  /** How often each file has been left in exactly the same state (an edit ↔ undo loop). */
  const fileStates = new Map<string, number>();
  const trackedFiles = new Set<string>();

  for (let step = 1; step <= maxSteps; step++) {
    stats.steps = step;
    emit({ type: 'agent:step', agent: agent.role, step, maxSteps });
    const result = await chatOnce(true);
    if (result.degenerate) {
      // Never feed the garbage back into the conversation: it only makes the next reply worse.
      badReplies++;
      if (badReplies >= BAD_REPLY_LIMIT) {
        return giveUp(
          `${model.name} kept producing garbled, repetitive output.`,
          'The model may be too small for this task or its files may be damaged — try another model with /models, or re-download it (ollama rm, then ollama pull).',
        );
      }
      emit({ type: 'notice', level: 'warn', text: `${agent.label}: the reply collapsed into repeated text and was cut off — retrying.` });
      messages.push({
        role: 'user',
        content:
          '[error] Your last reply degenerated into repeated or garbled text and was discarded. Answer again, and keep it short: one tool call or one file block.',
      });
      continue;
    }
    let calls = result.toolCalls;
    let prose = result.content;
    let textProtocol = false;
    let parseErrors: string[] = [];
    if (!calls.length) {
      const parsed = parseTextToolCalls(result.content, isKnownTool);
      // A tool call the API refused (e.g. Groq's validation) is reported back to the model like a malformed one.
      parseErrors =
        result.toolError && !parsed.calls.length ? [`Your tool call was rejected: ${result.toolError}`, ...parsed.errors] : parsed.errors;
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
      badReplies++;
      if (badReplies >= BAD_REPLY_LIMIT) {
        return giveUp(`${BAD_REPLY_LIMIT} replies in a row contained tool calls that could not be understood (${parseErrors[0]})`);
      }
      const cutOff =
        result.doneReason === 'length'
          ? '\nYour reply was cut off because it was too long. Write less per reply: one file, or one small edit, at a time.'
          : '';
      messages.push({ role: 'assistant', content: result.content.slice(0, 4000) });
      messages.push({ role: 'user', content: `[tool error]\n${parseErrors.join('\n')}${cutOff}\nPlease try again.` });
      continue;
    }
    badReplies = 0;

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
      if (def && (def.name === 'edit_file' || def.name === 'write_file')) {
        // Remember what the file looked like before its first change, so "back to the original" counts as a repeat.
        const before = fileState(toolContext, call.arguments.path ?? call.arguments.file_path);
        if (before && !trackedFiles.has(before.rel)) fileStates.set(before.key, 1);
        if (before) trackedFiles.add(before.rel);
      }
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
      if (repeats >= REPEAT_LIMIT) {
        loopReason = `the exact same ${res.name} call was made ${repeats} times`;
      }
      const isFileChange = res.name === 'edit_file' || res.name === 'write_file';
      if (isFileChange && !res.ok) {
        failedMutations++;
        if (failedMutations >= FAILED_EDIT_LIMIT) {
          loopReason = `${failedMutations} attempts in a row to write or edit files failed (last error: ${res.summary})`;
        }
      } else if (isFileChange) {
        failedMutations = 0;
        // Edit ↔ undo loops: the file keeps coming back to a state it was already in.
        const state = fileState(toolContext, res.args.path);
        if (state) {
          trackedFiles.add(state.rel);
          const times = (fileStates.get(state.key) ?? 0) + 1;
          fileStates.set(state.key, times);
          if (times >= 3) {
            loopReason = `${state.rel} was changed back and forth between the same versions ${times} times`;
          } else if (times === 2) {
            output += `\n\nNote: ${state.rel} is now exactly as it was after one of your earlier edits — you are undoing and redoing the same change. Only edit again if a DIFFERENT change is really needed; otherwise finish with a summary.`;
          }
        }
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
    if (loopReason && stuckOutput === undefined) return giveUp(loopReason);
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
