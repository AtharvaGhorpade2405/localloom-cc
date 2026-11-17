import type { AgentRole } from '../agents/events.js';
import { profileModel } from '../ollama/modelProfile.js';
import { isRemote, type ModelInfo } from '../ollama/types.js';

export type Complexity = 'low' | 'medium' | 'high';

const HIGH = /\b(refactor|architect|architecture|redesign|migrat|rewrite|entire|whole|across|multiple files|full[- ]stack|framework|concurren|async|performance|optimi[sz]e|security|algorithm|database|authentication|auth\b|api|test suite|implement .* (system|engine|service))/i;
const LOW = /\b(typo|rename|comment|small|simple|quick|minor|one[- ]line|tiny|format|explain|what is|what does|hello|hi\b|readme)\b/i;

/** Rough complexity estimate used as a fallback and as a hint for the router SLM. */
export function estimateComplexity(task: string): Complexity {
  const words = task.trim().split(/\s+/).filter(Boolean).length;
  let score = 0;
  if (HIGH.test(task)) score += 2;
  if (LOW.test(task)) score -= 2;
  if (words > 60) score += 2;
  else if (words > 25) score += 1;
  else if (words < 8) score -= 1;
  if (score >= 2) return 'high';
  if (score <= -1) return 'low';
  return 'medium';
}

/** Score a model for a given agent role. Higher is better. */
export function scoreModel(model: ModelInfo, role: AgentRole, complexity: Complexity): number {
  const p = profileModel(model);
  const params = model.paramsB || model.sizeBytes / 0.6e9 || 1; // ~0.6 GB per B at Q4
  const capability = Math.log2(params + 1) * 2; // diminishing returns on size
  let score = capability;
  switch (role) {
    case 'planner':
      score += (p.reasoning ? 3 : 0) + (p.coding ? 1 : 0);
      break;
    case 'coder':
      score += (p.coding ? 4 : 0) + (p.reasoning ? 0.5 : 0);
      break;
    case 'reviewer':
      score += (p.reasoning ? 2.5 : 0) + (p.coding ? 2 : 0);
      break;
    case 'fixer':
      score += (p.coding ? 3.5 : 0) + (p.reasoning ? 0.5 : 0);
      break;
  }
  // Tool calling matters for agents that act on the project.
  if (p.tools) score += role === 'planner' ? 1 : 2;
  // Larger context helps with real projects.
  if (model.contextLength >= 32768) score += 0.5;
  // Efficiency: penalize large models for simple tasks, small ones for hard tasks. Hosted models cost
  // no local time or memory, so only local ones are penalized for size.
  if (isRemote(model)) return score;
  if (complexity === 'low') score -= Math.max(0, params - 8) * 0.25;
  if (complexity === 'medium') score -= Math.max(0, params - 34) * 0.1;
  if (complexity === 'high' && params < 3) score -= 3;
  if (params < 1) score -= 4; // sub-1B models are rarely good agents
  return score;
}

/** The best hosted Groq model for writing code (or the user's preferred one). */
export function pickGroqCoder(models: ModelInfo[], preferred?: string): ModelInfo | undefined {
  const remote = models.filter(isRemote);
  if (preferred) {
    const want = preferred.toLowerCase().replace(/^groq\//, '');
    const m = remote.find((x) => x.name.toLowerCase() === `groq/${want}`);
    if (m) return m;
  }
  return [...remote].sort((a, b) => scoreModel(b, 'coder', 'high') - scoreModel(a, 'coder', 'high'))[0];
}

export function heuristicAssignment(
  models: ModelInfo[],
  complexity: Complexity,
): Record<AgentRole, string> {
  const pick = (role: AgentRole) =>
    [...models].sort((a, b) => scoreModel(b, role, complexity) - scoreModel(a, role, complexity))[0]!.name;
  return { planner: pick('planner'), coder: pick('coder'), reviewer: pick('reviewer'), fixer: pick('fixer') };
}

/** The router itself should be small and fast: always the smallest installed chat model. */
export function pickRouterModel(all: ModelInfo[], preferred?: string): ModelInfo {
  const local = all.filter((m) => !isRemote(m));
  const models = local.length ? local : all;
  if (preferred) {
    const m = models.find((x) => x.name === preferred || x.name === `${preferred}:latest`);
    if (m) return m;
  }
  const size = (m: ModelInfo) => m.paramsB || m.sizeBytes / 0.6e9 || Number.MAX_VALUE;
  // Ties (same parameter count) go to the smaller download, i.e. the faster quantization.
  return [...models].sort((a, b) => size(a) - size(b) || a.sizeBytes - b.sizeBytes)[0]!;
}
