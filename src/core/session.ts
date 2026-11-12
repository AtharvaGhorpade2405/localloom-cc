import { AGENTS } from '../agents/definitions.js';
import { AGENT_ROLES, type AgentRole, type EmitFn } from '../agents/events.js';
import { CancelledError, runAgent } from '../agents/runner.js';
import { extractTrailingJson, stripTrailingJsonBlock } from '../agents/toolParse.js';
import { describeShell, type LocalLoomConfig } from '../config.js';
import { resolveModelName, usableModels } from '../ollama/modelProfile.js';
import type { LLMClient, ModelInfo } from '../ollama/types.js';
import { estimateComplexity, heuristicAssignment, type Complexity } from '../router/heuristics.js';
import { routeTask, type Assignment, type RoutingResult } from '../router/router.js';
import { listDir } from '../tools/fsTools.js';
import { ApprovalPolicy, type ApprovalDecision, type ApprovalRequest, type ToolContext } from '../tools/registry.js';
import { Workspace } from '../tools/workspace.js';

export type Mode = 'auto' | 'manual';

export interface Plan {
  needsChanges: boolean;
  summary: string;
  steps: string[];
  files: string[];
  raw: string;
}

export interface ReviewIssue {
  file?: string;
  problem: string;
  fix?: string;
}

export interface Review {
  approved: boolean;
  issues: ReviewIssue[];
  raw: string;
}

interface MemoryEntry {
  request: string;
  outcome: string;
}

const ACTION_WORDS =
  /\b(create|add|fix|implement|refactor|write|update|change|remove|delete|rename|build|make|edit|install|convert|replace|generate|set ?up|scaffold|migrate|improve|optimi[sz]e|move)\b/i;

export function parsePlan(raw: string, request: string): Plan {
  const json = extractTrailingJson(raw, 'needs_changes');
  const strList = (v: unknown) => (Array.isArray(v) ? v.map((x) => String(x)).filter(Boolean) : []);
  if (json) {
    const nc = json.needs_changes;
    return {
      needsChanges: nc === true || nc === 'true',
      summary: typeof json.summary === 'string' ? json.summary : '',
      steps: strList(json.steps),
      files: strList(json.files),
      raw,
    };
  }
  return { needsChanges: ACTION_WORDS.test(request), summary: '', steps: [], files: [], raw };
}

export function parseReview(raw: string): Review {
  const json = extractTrailingJson(raw, 'verdict');
  if (!json) {
    // Unstructured reply: treat explicit approval language as approval, otherwise approve to avoid loops.
    const rejects = /\b(changes[_ ]requested|not approved|reject)\b/i.test(raw);
    return { approved: !rejects, issues: rejects ? [{ problem: raw.slice(0, 1500) }] : [], raw };
  }
  const verdict = String(json.verdict).toLowerCase();
  const issues: ReviewIssue[] = Array.isArray(json.issues)
    ? json.issues
        .map((i): ReviewIssue | undefined => {
          if (typeof i === 'string') return { problem: i };
          if (i && typeof i === 'object') {
            const o = i as Record<string, unknown>;
            const problem = String(o.problem ?? o.issue ?? o.description ?? '');
            if (!problem) return undefined;
            return {
              file: o.file ? String(o.file) : undefined,
              problem,
              fix: o.fix ?? o.suggestion ? String(o.fix ?? o.suggestion) : undefined,
            };
          }
          return undefined;
        })
        .filter((x): x is ReviewIssue => !!x)
    : [];
  const approved = verdict.startsWith('approve') || (verdict !== 'changes_requested' && issues.length === 0);
  return { approved: approved && !(verdict === 'changes_requested'), issues, raw };
}

export function cyclesFor(complexity: Complexity, max: number): number {
  const wanted = complexity === 'low' ? 1 : complexity === 'medium' ? 2 : 3;
  return Math.max(1, Math.min(max, wanted));
}

export interface SessionDeps {
  client: LLMClient;
  config: LocalLoomConfig;
  cwd: string;
}

/**
 * In-memory application state and the four-agent orchestration pipeline.
 * Nothing is persisted: state lives only for the duration of the process.
 */
export class Session {
  readonly client: LLMClient;
  readonly config: LocalLoomConfig;
  readonly workspace: Workspace;
  readonly policy: ApprovalPolicy;
  models: ModelInfo[] = [];
  mode: Mode = 'auto';
  manual: Partial<Assignment> = {};
  lastRouting?: RoutingResult;
  private memory: MemoryEntry[] = [];

  constructor(deps: SessionDeps) {
    this.client = deps.client;
    this.config = deps.config;
    this.workspace = new Workspace(deps.cwd);
    this.policy = new ApprovalPolicy(deps.config.autoApprove);
  }

  async refreshModels(): Promise<ModelInfo[]> {
    this.models = await this.client.listModels();
    // Drop manual choices that are no longer installed.
    for (const role of AGENT_ROLES) {
      const name = this.manual[role];
      if (name && !resolveModelName(name, this.models)) delete this.manual[role];
    }
    return this.models;
  }

  get usable(): ModelInfo[] {
    return usableModels(this.models);
  }

  /** Default model for manual mode: the best general coding model available. */
  defaultModel(): string | undefined {
    const u = this.usable;
    if (!u.length) return undefined;
    return heuristicAssignment(u, 'medium').coder;
  }

  setManualModel(name: string, role: AgentRole | 'all' = 'all'): ModelInfo {
    const model = resolveModelName(name, this.usable);
    if (!model) throw new Error(`Model "${name}" is not installed (or is not a chat model). Use /models to see installed models.`);
    if (role === 'all') for (const r of AGENT_ROLES) this.manual[r] = model.name;
    else this.manual[role] = model.name;
    this.mode = 'manual';
    return model;
  }

  manualAssignment(): Assignment | undefined {
    const fallback = this.defaultModel();
    if (!fallback) return undefined;
    const a = {} as Assignment;
    for (const r of AGENT_ROLES) a[r] = this.manual[r] ?? fallback;
    return a;
  }

  /** The assignment that would be shown in the UI right now (before a task runs). */
  currentAssignment(): Partial<Assignment> {
    if (this.mode === 'manual') return this.manualAssignment() ?? {};
    return this.lastRouting?.assignment ?? {};
  }

  clearMemory(): void {
    this.memory = [];
  }

  get memorySize(): number {
    return this.memory.length;
  }

  private modelInfo(name: string): ModelInfo {
    const m = resolveModelName(name, this.models);
    if (!m) throw new Error(`Model "${name}" is no longer installed. Run /models to refresh.`);
    return m;
  }

  private contextBlock(): string {
    let tree = '';
    try {
      tree = listDir(this.workspace, '.', 1).split('\n').slice(0, 60).join('\n');
    } catch {
      tree = '(unavailable)';
    }
    const history = this.memory
      .slice(-5)
      .map((m, i) => `${i + 1}. User: ${m.request.slice(0, 300)}\n   Result: ${m.outcome.slice(0, 500)}`)
      .join('\n');
    return [
      `## Environment`,
      `- OS: ${this.config.platform}; shell for run_command: ${describeShell(this.config)}`,
      `- Project root: ${this.workspace.root}`,
      `- Date: ${new Date().toISOString().slice(0, 10)}`,
      ``,
      `## Project top level`,
      tree,
      history ? `\n## Earlier in this conversation\n${history}` : '',
    ].join('\n');
  }

  async runTask(
    task: string,
    emit: EmitFn,
    requestApproval: (req: ApprovalRequest) => Promise<ApprovalDecision>,
    signal?: AbortSignal,
  ): Promise<void> {
    emit({ type: 'task:start', task });
    this.workspace.resetChanges();
    const toolContext: ToolContext = {
      workspace: this.workspace,
      config: this.config,
      policy: this.policy,
      signal,
      requestApproval,
    };
    const run = (role: AgentRole, model: string, prompt: string, extra: Partial<Parameters<typeof runAgent>[0]> = {}, label?: string) => {
      emit({ type: 'agent:start', agent: role, model, label });
      return runAgent({
        agent: AGENTS[role],
        model: this.modelInfo(model),
        prompt,
        client: this.client,
        config: this.config,
        toolContext,
        emit,
        signal,
        ...extra,
      });
    };
    let currentRole: AgentRole | undefined;

    try {
      if (!this.models.length) await this.refreshModels();
      // 1. Model assignment
      let routing: RoutingResult;
      if (this.mode === 'auto') {
        emit({ type: 'routing:start' });
        routing = await routeTask(this.client, task, this.models, { routerModel: this.config.routerModel, signal });
      } else {
        const a = this.manualAssignment();
        if (!a) throw new Error('No chat models installed. Pull one with `ollama pull qwen2.5-coder:7b`.');
        routing = {
          assignment: a,
          complexity: estimateComplexity(task),
          reasoning: 'Manual mode: models chosen by you.',
          source: 'manual',
          corrected: [],
        };
      }
      this.lastRouting = routing;
      emit({ type: 'routing', result: routing });
      const A = routing.assignment;
      const ctx = this.contextBlock();

      // 2. Planner
      currentRole = 'planner';
      const planRun = await run(
        'planner',
        A.planner,
        `${ctx}\n\n## User request\n${task}\n\nExplore as needed, then answer or plan. End with the JSON block.`,
      );
      const plan = parsePlan(planRun.content, task);
      emit({ type: 'agent:end', agent: 'planner', status: 'done' });

      if (!plan.needsChanges) {
        for (const r of ['coder', 'reviewer', 'fixer'] as AgentRole[]) {
          emit({ type: 'agent:end', agent: r, status: 'skipped', note: 'not needed' });
        }
        const answer = stripTrailingJsonBlock(planRun.content, 'needs_changes');
        this.memory.push({ request: task, outcome: answer.slice(0, 600) });
        emit({ type: 'task:end', status: 'done', summary: 'Answered by the Planner — no changes needed.', changedFiles: [] });
        return;
      }

      const planText = [
        plan.summary && `Goal: ${plan.summary}`,
        plan.steps.length ? plan.steps.map((s, i) => `${i + 1}. ${s}`).join('\n') : stripTrailingJsonBlock(plan.raw, 'needs_changes'),
        plan.files.length ? `Files: ${plan.files.join(', ')}` : '',
      ]
        .filter(Boolean)
        .join('\n');

      // 3. Coder
      currentRole = 'coder';
      const codeRun = await run(
        'coder',
        A.coder,
        `${ctx}\n\n## User request\n${task}\n\n## Plan from the Planner\n${planText}\n\nImplement the plan now using the tools.`,
        {
          checkFinal: (_content, stats) =>
            stats.mutatingCalls === 0 && this.workspace.changedFiles().length === 0
              ? 'You have not changed any files yet. Implement the plan NOW by calling write_file or edit_file (and run_command if needed). If truly nothing needs to change, explain why.'
              : undefined,
        },
      );
      emit({ type: 'agent:end', agent: 'coder', status: 'done' });
      let latestSummary = stripTrailingJsonBlock(codeRun.content, 'verdict');

      // 4. Review → fix cycles
      const cycles = cyclesFor(routing.complexity, this.config.maxReviewCycles);
      let review: Review | undefined;
      let unreviewedFixes = false;
      for (let cycle = 1; cycle <= cycles; cycle++) {
        const changed = this.workspace.changedFiles();
        const changedText = changed.length ? changed.map((c) => `- ${c.path} (${c.status})`).join('\n') : '(no files were changed)';
        currentRole = 'reviewer';
        emit({ type: 'phase', text: `Review cycle ${cycle}/${cycles}` });
        const reviewRun = await run(
          'reviewer',
          A.reviewer,
          `${ctx}\n\n## User request\n${task}\n\n## Plan\n${planText}\n\n## Implementer's summary\n${latestSummary.slice(0, 2000)}\n\n## Changed files\n${changedText}\n\n## Diff\n\`\`\`diff\n${this.workspace.diff() || '(empty)'}\n\`\`\`\n\nReview the changes and finish with the JSON verdict.`,
          {},
          `cycle ${cycle}/${cycles}`,
        );
        review = parseReview(reviewRun.content);
        unreviewedFixes = false;
        emit({ type: 'agent:end', agent: 'reviewer', status: 'done', note: review.approved ? 'approved' : `${review.issues.length} issue(s)` });
        if (review.approved) break;

        const issuesText = review.issues.length
          ? review.issues.map((i, n) => `${n + 1}. ${i.file ? `[${i.file}] ` : ''}${i.problem}${i.fix ? `\n   Suggested fix: ${i.fix}` : ''}`).join('\n')
          : stripTrailingJsonBlock(review.raw, 'verdict');
        currentRole = 'fixer';
        const fixRun = await run(
          'fixer',
          A.fixer,
          `${ctx}\n\n## User request\n${task}\n\n## Changed files so far\n${changedText}\n\n## Issues found by the Reviewer\n${issuesText}\n\nFix these issues now using the tools.`,
          {},
          `cycle ${cycle}/${cycles}`,
        );
        emit({ type: 'agent:end', agent: 'fixer', status: 'done' });
        latestSummary = fixRun.content;
        unreviewedFixes = true;
      }
      if (review?.approved) emit({ type: 'agent:end', agent: 'fixer', status: 'skipped', note: 'no issues' });

      const changed = this.workspace.changedFiles();
      const files = changed.map((c) => `${c.path} (${c.status})`);
      let summary: string;
      if (review?.approved) summary = 'Reviewer approved the changes.';
      else if (unreviewedFixes) summary = `Fixes applied after the final review cycle (limit ${cycles} reached; not re-reviewed).`;
      else summary = 'Review cycle limit reached with open issues.';
      this.memory.push({
        request: task,
        outcome: `${summary} Files: ${files.join(', ') || 'none'}. ${latestSummary.slice(0, 300)}`,
      });
      emit({ type: 'task:end', status: 'done', summary, changedFiles: files });
    } catch (err) {
      if (err instanceof CancelledError || signal?.aborted) {
        if (currentRole) emit({ type: 'agent:end', agent: currentRole, status: 'error', note: 'cancelled' });
        this.memory.push({ request: task, outcome: 'Cancelled by the user.' });
        emit({ type: 'task:end', status: 'cancelled', summary: 'Cancelled.', changedFiles: this.workspace.changedFiles().map((c) => c.path) });
        return;
      }
      if (currentRole) emit({ type: 'agent:end', agent: currentRole, status: 'error', note: (err as Error).message });
      emit({ type: 'notice', level: 'error', text: (err as Error).message });
      emit({ type: 'task:end', status: 'error', summary: (err as Error).message, changedFiles: this.workspace.changedFiles().map((c) => c.path) });
    }
  }
}
