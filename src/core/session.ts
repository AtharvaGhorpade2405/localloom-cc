import fs from 'node:fs';
import path from 'node:path';
import { AGENTS } from '../agents/definitions.js';
import { AGENT_ROLES, type AgentRole, type EmitFn } from '../agents/events.js';
import { CancelledError, runAgent } from '../agents/runner.js';
import { extractTrailingJson, stripTrailingJsonBlock } from '../agents/toolParse.js';
import { describeShell, type LocalLoomConfig } from '../config.js';
import { resolveModelName, usableModels } from '../ollama/modelProfile.js';
import { isRemote, type LLMClient, type ModelInfo } from '../ollama/types.js';
import { estimateComplexity, heuristicAssignment, pickGroqCoder, type Complexity } from '../router/heuristics.js';
import { routeTask, type Assignment, type RoutingResult } from '../router/router.js';
import { listDir } from '../tools/fsTools.js';
import { ApprovalPolicy, type ApprovalDecision, type ApprovalRequest, type ToolContext } from '../tools/registry.js';
import { formatReport, verifyChanges } from '../tools/verify.js';
import { Workspace } from '../tools/workspace.js';
import { buildCheckpoint, captureBaseline, undoCheckpoint, type Baseline, type Checkpoint, type UndoOutcome } from './checkpoints.js';
import { createProjectDir, looksLikeNewProject, projectNameFor, removeIfEmpty } from './projects.js';

/** How many requests back /undo can go. */
export const MAX_CHECKPOINTS = 20;

export type UndoResult =
  | { status: 'nothing' }
  | { status: 'conflict'; task: string; conflicts: string[] }
  | ({ status: 'done'; task: string; complete: boolean; removedProject: boolean; remaining: number } & UndoOutcome);

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

export interface MemoryEntry {
  request: string;
  outcome: string;
}

/** The part of a Session that is saved with the chat history so a conversation can be resumed. */
export interface SessionSnapshot {
  memory: MemoryEntry[];
  project?: ActiveProject;
  /** The folder the agents were working in. */
  workspaceRoot: string;
}

const ACTION_WORDS =
  /\b(create|add|fix|implement|refactor|write|update|change|remove|delete|rename|build|make|edit|install|convert|replace|generate|set ?up|scaffold|migrate|improve|optimi[sz]e|move)\b/i;

const REWRITE_WORDS = /\b(rewrite|re-write|from scratch|start over|overwrite|replace (the )?(whole|entire))\b/i;

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
  const wanted = complexity === 'high' ? 3 : 2;
  return Math.max(1, Math.min(max, wanted));
}

export interface SessionDeps {
  client: LLMClient;
  config: LocalLoomConfig;
  cwd: string;
  /**
   * When set, every new project request gets its own folder inside this directory and the agents
   * are confined to it. When omitted, the agents work directly in `cwd` (edit an existing project).
   */
  projectsRoot?: string;
}

export interface ActiveProject {
  name: string;
  dir: string;
}

/**
 * Application state and the four-agent orchestration pipeline. The state lives in memory; the UI
 * saves a snapshot of it (see `snapshot()`) to the local chat history so chats can be resumed.
 */
export class Session {
  readonly client: LLMClient;
  readonly config: LocalLoomConfig;
  /** Where the agents may work right now: the active project folder (or `cwd` without project folders). */
  workspace: Workspace;
  readonly projectsRoot?: string;
  project?: ActiveProject;
  private startFresh = false;
  /** Auto mode: the Coder and Fixer run on Groq; the router, Planner and Reviewer stay local. */
  groqCoding: boolean;
  /** Preferred Groq model for coding (without the "groq/" prefix). */
  groqModel?: string;
  readonly policy: ApprovalPolicy;
  models: ModelInfo[] = [];
  mode: Mode = 'auto';
  manual: Partial<Assignment> = {};
  lastRouting?: RoutingResult;
  private memory: MemoryEntry[] = [];
  /** One per request that changed files, newest last, with the memory entry it produced. */
  private checkpoints: { checkpoint: Checkpoint; entry?: MemoryEntry }[] = [];

  constructor(deps: SessionDeps) {
    this.client = deps.client;
    this.config = deps.config;
    if (deps.projectsRoot) {
      fs.mkdirSync(deps.projectsRoot, { recursive: true });
      this.projectsRoot = fs.realpathSync(deps.projectsRoot);
      this.workspace = new Workspace(this.projectsRoot);
    } else {
      this.workspace = new Workspace(deps.cwd);
    }
    this.policy = new ApprovalPolicy(deps.config.autoApprove);
    this.groqCoding = deps.config.groqCoding;
    this.groqModel = deps.config.groqModel;
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

  /** Hosted Groq models currently offered. */
  get groqModels(): ModelInfo[] {
    return this.usable.filter(isRemote);
  }

  /** Why Groq models could not be listed (missing key is not an error). */
  get groqError(): string | undefined {
    return (this.client as { remoteError?: string }).remoteError;
  }

  /** The Groq model the Coder and Fixer use when Groq coding is on. */
  groqCoder(): ModelInfo | undefined {
    return pickGroqCoder(this.usable, this.groqModel);
  }

  /** Default model for manual mode: the best local coding model (a hosted one only if nothing is local). */
  defaultModel(): string | undefined {
    const u = this.usable;
    if (!u.length) return undefined;
    const local = u.filter((m) => !isRemote(m));
    return heuristicAssignment(local.length ? local : u, 'medium').coder;
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

  /** Make the next request start a new project folder instead of continuing the current one. */
  newProject(): void {
    this.startFresh = true;
  }

  /**
   * Pick the folder this task works in: continue the active project, or create a new one when
   * there is none, the user asked for one (/new) or the request describes a brand-new project.
   */
  private prepareProject(task: string, emit: EmitFn): boolean {
    if (!this.projectsRoot) return false;
    const current = this.project;
    if (current && fs.existsSync(current.dir) && !this.startFresh && !looksLikeNewProject(task)) {
      emit({ type: 'notice', level: 'info', text: `Project · ${current.name} (continuing — /new starts another one)` });
      return false;
    }
    this.startFresh = false;
    const created = createProjectDir(this.projectsRoot, projectNameFor(task));
    this.project = created;
    this.workspace = new Workspace(created.dir);
    this.memory = [];
    emit({
      type: 'notice',
      level: 'success',
      text: `New project · ${path.join(path.basename(this.projectsRoot), created.name)} — agents can read, write, edit and delete only inside this folder`,
    });
    return true;
  }

  /** A project folder that received nothing (e.g. the request was only a question) is not kept. */
  private discardEmptyProject(): void {
    if (!this.projectsRoot || !this.project) return;
    if (removeIfEmpty(this.project.dir)) {
      this.project = undefined;
      this.workspace = new Workspace(this.projectsRoot);
    }
  }

  /** Auto mode with Groq coding on: hand the Coder and Fixer to the best (or chosen) Groq model. */
  private withGroqCoding(routing: RoutingResult, emit: EmitFn): RoutingResult {
    const groq = this.groqCoder();
    if (!groq) {
      const why = this.groqError ?? (this.config.groqApiKey ? 'Groq returned no chat models' : 'GROQ_API_KEY is not set');
      emit({ type: 'notice', level: 'warn', text: `Groq coding is on, but no Groq model is available (${why}). Using local models for every agent.` });
      return routing;
    }
    return {
      ...routing,
      assignment: { ...routing.assignment, coder: groq.name, fixer: groq.name },
      reasoning: `${routing.reasoning} Coder and Fixer run on Groq (${groq.name}); the rest stays local.`,
    };
  }

  clearMemory(): void {
    this.memory = [];
    this.checkpoints = [];
  }

  /** How many requests /undo can revert, newest first. */
  get undoable(): string[] {
    return this.checkpoints.map((c) => c.checkpoint.task).reverse();
  }

  /**
   * Revert the file changes of the most recent request that made any. Refuses (status "conflict")
   * when those files were changed afterwards, unless `force` is set.
   */
  undo(opts: { force?: boolean } = {}): UndoResult {
    const last = this.checkpoints.at(-1);
    if (!last) return { status: 'nothing' };
    const cp = last.checkpoint;
    const outcome = undoCheckpoint(cp, opts);
    if (!outcome.applied) return { status: 'conflict', task: cp.task, conflicts: outcome.conflicts };
    this.checkpoints.pop();
    if (last.entry && this.memory.includes(last.entry)) {
      last.entry.outcome = 'Undone by the user with /undo: every file change from this request was reverted.';
    }
    let removedProject = false;
    if (cp.projectDir && this.projectsRoot && removeIfEmpty(cp.projectDir)) {
      removedProject = true;
      if (this.project?.dir === cp.projectDir) {
        this.project = undefined;
        this.workspace = new Workspace(this.projectsRoot);
      }
    }
    return { status: 'done', task: cp.task, complete: cp.complete, removedProject, remaining: this.checkpoints.length, ...outcome };
  }

  private recordCheckpoint(baseline: Baseline | undefined, task: string, memoryBefore: number, createdProject: boolean): void {
    if (!baseline) return;
    let checkpoint: Checkpoint | undefined;
    try {
      checkpoint = buildCheckpoint(baseline, this.workspace.originalEntries(), task);
    } catch {
      return;
    }
    if (!checkpoint) return;
    if (createdProject && this.project && this.project.dir === baseline.root) checkpoint.projectDir = baseline.root;
    this.checkpoints.push({ checkpoint, entry: this.memory.length > memoryBefore ? this.memory.at(-1) : undefined });
    if (this.checkpoints.length > MAX_CHECKPOINTS) this.checkpoints.shift();
  }

  get memorySize(): number {
    return this.memory.length;
  }

  snapshot(): SessionSnapshot {
    return {
      memory: this.memory.map((m) => ({ ...m })),
      project: this.project ? { ...this.project } : undefined,
      workspaceRoot: this.workspace.root,
    };
  }

  /**
   * Resume a saved conversation: restore its context and, when it still exists, its project folder.
   * Returns a warning when the folder it worked in is gone.
   */
  restore(snap: SessionSnapshot): string | undefined {
    this.memory = Array.isArray(snap.memory) ? snap.memory.map((m) => ({ request: String(m.request), outcome: String(m.outcome) })) : [];
    this.checkpoints = [];
    this.startFresh = false;
    if (!this.projectsRoot) {
      // --here: the agents always work in the start directory.
      return snap.workspaceRoot && path.resolve(snap.workspaceRoot) !== path.resolve(this.workspace.root)
        ? `This chat worked in ${snap.workspaceRoot}; continuing in ${this.workspace.root}.`
        : undefined;
    }
    const dir = snap.project?.dir;
    if (snap.project && dir && fs.existsSync(dir) && fs.statSync(dir).isDirectory()) {
      const real = fs.realpathSync(dir);
      const rel = path.relative(this.projectsRoot, real);
      if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) {
        this.project = { name: snap.project.name, dir: real };
        this.workspace = new Workspace(real);
        return undefined;
      }
      this.project = undefined;
      this.workspace = new Workspace(this.projectsRoot);
      return `This chat's project (${dir}) is outside the current projects folder; your next request will start a new project.`;
    }
    this.project = undefined;
    this.workspace = new Workspace(this.projectsRoot);
    return snap.project ? `The project folder ${snap.project.dir} no longer exists; your next request will start a new project.` : undefined;
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
    let createdProject = false;
    try {
      createdProject = this.prepareProject(task, emit);
    } catch (err) {
      const message = `Could not create the project folder: ${(err as Error).message}`;
      emit({ type: 'notice', level: 'error', text: message });
      emit({ type: 'task:end', status: 'error', summary: message, changedFiles: [] });
      return;
    }
    // Snapshot the folder so /undo can revert this request, including changes made by commands.
    let baseline: Baseline | undefined;
    try {
      baseline = captureBaseline(this.workspace.root);
      if (!baseline.complete) {
        emit({
          type: 'notice',
          level: 'warn',
          text: 'This folder is too large to snapshot, so /undo will only revert files changed by the file tools (not by commands).',
        });
      }
    } catch {
      baseline = undefined;
    }
    const memoryBefore = this.memory.length;
    try {
      await this.runPipeline(task, emit, requestApproval, signal, createdProject);
    } finally {
      this.recordCheckpoint(baseline, task, memoryBefore, createdProject);
    }
  }

  private async runPipeline(
    task: string,
    emit: EmitFn,
    requestApproval: (req: ApprovalRequest) => Promise<ApprovalDecision>,
    signal: AbortSignal | undefined,
    createdProject: boolean,
  ): Promise<void> {
    this.workspace.resetChanges();
    const toolContext: ToolContext = {
      workspace: this.workspace,
      config: this.config,
      policy: this.policy,
      signal,
      requestApproval,
      // Existing files are edited in place; whole-file rewrites only when the user asks for one.
      allowOverwrite: REWRITE_WORDS.test(task),
      // Inside a LocalLoom project folder the agents have full file permissions, and nothing outside it.
      confined: !!this.projectsRoot,
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
      if (this.mode === 'auto' && this.groqCoding) routing = this.withGroqCoding(routing, emit);
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
        if (createdProject) this.discardEmptyProject();
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
              ? 'You have not changed any files yet. Implement the plan NOW: create new files with write_file and change existing ones with edit_file (and run_command if needed). If truly nothing needs to change, explain why.'
              : undefined,
        },
      );
      emit({ type: 'agent:end', agent: 'coder', status: 'done' });
      let latestSummary = stripTrailingJsonBlock(codeRun.content, 'verdict');

      // 4. Review → fix cycles, grounded by automatic syntax checks of every changed file.
      const verify = async () => {
        const report = await verifyChanges(this.workspace);
        for (const c of report.checks) {
          emit({
            type: 'tool:end',
            agent: 'reviewer',
            id: `verify-${c.path}-${Date.now()}`,
            name: 'syntax check',
            detail: c.path,
            ok: c.ok,
            summary: c.ok ? c.checker : `${c.checker} failed`,
          });
        }
        return report;
      };
      const cycles = cyclesFor(routing.complexity, this.config.maxReviewCycles);
      let review: Review | undefined;
      let unreviewedFixes = false;
      let report = await verify();
      for (let cycle = 1; cycle <= cycles; cycle++) {
        const changed = this.workspace.changedFiles();
        const changedText = changed.length ? changed.map((c) => `- ${c.path} (${c.status})`).join('\n') : '(no files were changed)';
        currentRole = 'reviewer';
        emit({ type: 'phase', text: `Review cycle ${cycle}/${cycles}` });
        const reviewRun = await run(
          'reviewer',
          A.reviewer,
          `${ctx}\n\n## User request\n${task}\n\n## Plan\n${planText}\n\n## Implementer's summary\n${latestSummary.slice(0, 2000)}\n\n## Changed files\n${changedText}\n\n## Automatic syntax checks (run by LocalLoom)\n${formatReport(report)}\n\n## Diff\n\`\`\`diff\n${this.workspace.diff() || '(empty)'}\n\`\`\`\n\nReview the changes and finish with the JSON verdict.`,
          {},
          `cycle ${cycle}/${cycles}`,
        );
        review = parseReview(reviewRun.content);
        // Objective failures override the model's verdict: broken code is never approved.
        if (!report.ok) {
          const failed = report.checks.filter((c) => !c.ok);
          review = {
            ...review,
            approved: false,
            issues: [
              ...failed.map((c) => ({ file: c.path, problem: `Syntax check failed (${c.checker}):\n${c.message}`, fix: 'Fix the syntax error at the reported line.' })),
              ...review.issues,
            ],
          };
        }
        if (changed.length === 0 && review.approved && plan.needsChanges) {
          review = { ...review, approved: false, issues: [{ problem: 'No files were created or changed, but the request requires changes. Implement it.' }, ...review.issues] };
        }
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
          `${ctx}\n\n## User request\n${task}\n\n## Plan\n${planText}\n\n## Changed files so far\n${changedText}\n\n## Issues found by the Reviewer\n${issuesText}\n\nRead the affected files, then fix these issues now using the tools.`,
          {},
          `cycle ${cycle}/${cycles}`,
        );
        emit({ type: 'agent:end', agent: 'fixer', status: 'done' });
        latestSummary = fixRun.content;
        unreviewedFixes = true;
        report = await verify();
      }
      if (review?.approved) emit({ type: 'agent:end', agent: 'fixer', status: 'skipped', note: 'no issues' });

      const changed = this.workspace.changedFiles();
      const files = changed.map((c) => `${c.path} (${c.status})`);
      const checksNote = report.checks.length ? (report.ok ? ' Syntax checks pass.' : ' Syntax errors remain — see the check results above.') : '';
      let summary: string;
      if (review?.approved) summary = `Reviewer approved the changes.${checksNote}`;
      else if (unreviewedFixes) summary = `Fixes applied after the final review cycle (limit ${cycles} reached; not re-reviewed).${checksNote}`;
      else summary = `Review cycle limit reached with open issues.${checksNote}`;
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
