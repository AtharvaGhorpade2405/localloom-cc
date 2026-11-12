import { z } from 'zod';
import { AGENT_ROLES, type AgentRole } from '../agents/events.js';
import { extractTrailingJson } from '../agents/toolParse.js';
import { describeModel, formatBytes, resolveModelName, usableModels } from '../ollama/modelProfile.js';
import type { LLMClient, ModelInfo } from '../ollama/types.js';
import { estimateComplexity, heuristicAssignment, pickRouterModel, type Complexity } from './heuristics.js';

export type Assignment = Record<AgentRole, string>;

export interface RoutingResult {
  assignment: Assignment;
  complexity: Complexity;
  reasoning: string;
  source: 'slm' | 'heuristic' | 'single' | 'manual';
  routerModel?: string;
  /** Roles where the SLM's choice was invalid and the heuristic was used instead. */
  corrected: AgentRole[];
}

const RouterOutputSchema = z.object({
  complexity: z.enum(['low', 'medium', 'high']).catch('medium'),
  planner: z.string(),
  coder: z.string(),
  reviewer: z.string(),
  fixer: z.string(),
  reasoning: z.string().optional().default(''),
});

const ROUTER_JSON_SCHEMA = {
  type: 'object',
  properties: {
    complexity: { type: 'string', enum: ['low', 'medium', 'high'] },
    planner: { type: 'string' },
    coder: { type: 'string' },
    reviewer: { type: 'string' },
    fixer: { type: 'string' },
    reasoning: { type: 'string' },
  },
  required: ['complexity', 'planner', 'coder', 'reviewer', 'fixer', 'reasoning'],
};

export function buildRouterPrompt(task: string, models: ModelInfo[], hint: Complexity): string {
  const catalog = models
    .map(
      (m) =>
        `- ${m.name}: ${describeModel(m)}; context ${m.contextLength}; size ${formatBytes(m.sizeBytes)}`,
    )
    .join('\n');
  return `You are the model router of a local coding assistant with four agents:
- planner: understands the task and writes a plan (needs reasoning)
- coder: writes and edits code with tools (needs strong coding ability and tool use)
- reviewer: finds bugs in the changes (needs reasoning and code understanding)
- fixer: applies targeted fixes (needs coding ability; efficiency matters)

Installed models (you MUST choose only from these exact names):
${catalog}

Guidelines:
- Estimate task complexity: low (trivial/small edits/questions), medium (typical feature or bug fix), high (multi-file, architectural, tricky logic).
- Prefer coding-specialized models for coder and fixer, reasoning-capable models for planner and reviewer.
- For low complexity prefer smaller, faster models; for high complexity prefer larger, more capable models.
- Larger parameter counts generally mean better quality but slower speed. Models with "tools" support are better agents.
- Different agents may use different models. Reusing one model is fine if it is clearly the best.
(A rough heuristic estimate of complexity is: ${hint}.)

Task:
"""
${task.slice(0, 2000)}
"""

Reply with only JSON: {"complexity": "...", "planner": "<model>", "coder": "<model>", "reviewer": "<model>", "fixer": "<model>", "reasoning": "<one short sentence>"}`;
}

export interface RouteOptions {
  routerModel?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
}

/**
 * Auto mode: ask a small local model to assign installed models to agents.
 * Always returns a valid assignment of installed models; falls back to heuristics on any failure.
 */
export async function routeTask(
  client: LLMClient,
  task: string,
  installed: ModelInfo[],
  opts: RouteOptions = {},
): Promise<RoutingResult> {
  const models = usableModels(installed);
  if (!models.length) throw new Error('No usable chat models are installed in Ollama. Pull one with `ollama pull qwen2.5-coder:7b`.');
  const hint = estimateComplexity(task);
  const fallback = heuristicAssignment(models, hint);

  if (models.length === 1) {
    const only = models[0]!.name;
    return {
      assignment: { planner: only, coder: only, reviewer: only, fixer: only },
      complexity: hint,
      reasoning: `Only one chat model is installed (${only}); all agents use it.`,
      source: 'single',
      corrected: [],
    };
  }

  const router = pickRouterModel(models, opts.routerModel);
  try {
    const signals = [AbortSignal.timeout(opts.timeoutMs ?? 90_000)];
    if (opts.signal) signals.push(opts.signal);
    const res = await client.chat(
      {
        model: router.name,
        messages: [{ role: 'user', content: buildRouterPrompt(task, models, hint) }],
        format: ROUTER_JSON_SCHEMA,
        options: { temperature: 0, num_ctx: 4096 },
        think: false,
        keepAlive: '5m',
      },
      {},
      AbortSignal.any(signals),
    );
    const raw = safeJson(res.content) ?? extractTrailingJson(res.content, 'coder');
    const parsed = RouterOutputSchema.safeParse(raw);
    if (!parsed.success) throw new Error('router returned malformed JSON');
    const out = parsed.data;
    const corrected: AgentRole[] = [];
    const assignment = {} as Assignment;
    for (const role of AGENT_ROLES) {
      const resolved = resolveModelName(out[role], models);
      if (resolved) assignment[role] = resolved.name;
      else {
        assignment[role] = fallback[role];
        corrected.push(role);
      }
    }
    return {
      assignment,
      complexity: out.complexity,
      reasoning: out.reasoning || 'Assigned by router.',
      source: 'slm',
      routerModel: router.name,
      corrected,
    };
  } catch (err) {
    if (opts.signal?.aborted) throw err;
    return {
      assignment: fallback,
      complexity: hint,
      reasoning: `Router (${router.name}) failed: ${(err as Error).message}. Used capability heuristics instead.`,
      source: 'heuristic',
      routerModel: router.name,
      corrected: [],
    };
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
