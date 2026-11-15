import { z } from 'zod';
import type { LocalLoomConfig } from '../config.js';
import type { ToolSpec } from '../ollama/types.js';
import { assessCommand } from './commandSafety.js';
import { deleteFile, editFile, findFiles, listDir, readFile, searchCode, writeFile } from './fsTools.js';
import { runShellCommand } from './runCommand.js';
import { checkFile, detectNeverExiting } from './verify.js';
import type { Workspace } from './workspace.js';

export type ApprovalDecision = 'yes' | 'always' | 'no';

export interface ApprovalRequest {
  kind: 'command' | 'delete';
  title: string;
  detail: string;
  reason: string;
}

/** Per-session approval memory. */
export class ApprovalPolicy {
  autoApprove: boolean;
  private allowed = new Set<string>();
  constructor(autoApprove = false) {
    this.autoApprove = autoApprove;
  }
  isAllowed(key: string): boolean {
    return this.autoApprove || this.allowed.has(key);
  }
  allow(key: string): void {
    this.allowed.add(key);
  }
}

export interface ToolContext {
  workspace: Workspace;
  config: LocalLoomConfig;
  policy: ApprovalPolicy;
  signal?: AbortSignal;
  requestApproval: (req: ApprovalRequest) => Promise<ApprovalDecision>;
}

export interface ToolOutput {
  ok: boolean;
  /** Text returned to the model. */
  output: string;
  /** Short human-readable summary for the UI. */
  summary: string;
}

export interface ToolDefinition {
  name: string;
  description: string;
  schema: z.ZodType;
  /** True when the tool never modifies anything. */
  readOnly: boolean;
  /** One-line description of a call, for the UI. */
  describe: (args: Record<string, unknown>) => string;
  run: (args: never, ctx: ToolContext) => Promise<ToolOutput>;
}

const optInt = z.coerce.number().int().positive().optional();
const optBool = z
  .union([z.boolean(), z.string().transform((s) => s.toLowerCase() === 'true')])
  .optional();

function defineTool<S extends z.ZodType>(def: {
  name: string;
  description: string;
  schema: S;
  readOnly: boolean;
  describe: (args: Record<string, unknown>) => string;
  run: (args: z.infer<S>, ctx: ToolContext) => Promise<ToolOutput>;
}): ToolDefinition {
  return def as unknown as ToolDefinition;
}

const str = (v: unknown, max = 60): string => {
  const s = typeof v === 'string' ? v : JSON.stringify(v ?? '');
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
};

export const TOOLS: ToolDefinition[] = [
  defineTool({
    name: 'list_dir',
    description: 'List files and folders in a project directory as a tree. Use "." for the project root.',
    schema: z.object({
      path: z.string().default('.').describe('Directory path relative to the project root'),
      depth: z.coerce.number().int().min(1).max(4).default(2).describe('How many levels deep to list (1-4)'),
    }),
    readOnly: true,
    describe: (a) => `${str(a.path ?? '.')}`,
    run: async (a, ctx) => {
      const text = listDir(ctx.workspace, a.path, a.depth);
      return { ok: true, output: text, summary: `${text.split('\n').length} entries` };
    },
  }),
  defineTool({
    name: 'read_file',
    description: 'Read a text file from the project. Returns content with line numbers. Optionally read a line range.',
    schema: z.object({
      path: z.string().describe('File path relative to the project root'),
      start_line: optInt.describe('First line to read (1-based)'),
      end_line: optInt.describe('Last line to read (inclusive)'),
    }),
    readOnly: true,
    describe: (a) => str(a.path),
    run: async (a, ctx) => {
      const { text, lines } = readFile(ctx.workspace, a.path, a.start_line, a.end_line);
      return { ok: true, output: text, summary: `${lines} lines` };
    },
  }),
  defineTool({
    name: 'search_code',
    description:
      'Search file contents in the project for a regex or text pattern (like grep). Returns matching lines as path:line: text.',
    schema: z.object({
      pattern: z.string().min(1).describe('Regular expression or plain text to search for'),
      path: z.string().optional().describe('Directory or file to search in (default: project root)'),
      glob: z.string().optional().describe('Only search files matching this glob, e.g. "*.ts" or "src/**/*.py"'),
      case_sensitive: optBool.describe('Match case exactly (default false)'),
    }),
    readOnly: true,
    describe: (a) => `"${str(a.pattern, 40)}"${a.glob ? ` in ${str(a.glob, 20)}` : ''}`,
    run: async (a, ctx) => {
      const { text, matches } = searchCode(ctx.workspace, {
        pattern: a.pattern,
        path: a.path,
        glob: a.glob,
        caseSensitive: a.case_sensitive,
      });
      return { ok: true, output: text, summary: `${matches} matches` };
    },
  }),
  defineTool({
    name: 'find_files',
    description: 'Find files in the project by name or glob pattern, e.g. "*.test.ts", "package.json", "src/**/*.css".',
    schema: z.object({ pattern: z.string().min(1).describe('Glob pattern or file name') }),
    readOnly: true,
    describe: (a) => str(a.pattern),
    run: async (a, ctx) => {
      const { text, count } = findFiles(ctx.workspace, a.pattern);
      return { ok: true, output: text, summary: `${count} files` };
    },
  }),
  defineTool({
    name: 'write_file',
    description:
      'Create a new file or completely overwrite an existing file with the given content. Parent folders are created automatically. Always provide the COMPLETE file content.',
    schema: z.object({
      path: z.string().describe('File path relative to the project root'),
      content: z.string().describe('The full content of the file'),
    }),
    readOnly: false,
    describe: (a) => str(a.path),
    run: async (a, ctx) => {
      const { created, lines } = writeFile(ctx.workspace, a.path, a.content);
      const rel = ctx.workspace.relative(ctx.workspace.resolve(a.path));
      return {
        ok: true,
        output: `${created ? 'Created' : 'Overwrote'} ${rel} (${lines} lines).`,
        summary: `${created ? 'created' : 'overwrote'} · ${lines} lines`,
      };
    },
  }),
  defineTool({
    name: 'edit_file',
    description:
      'Edit an existing file by replacing an exact snippet of text. old_string must match the file exactly (copy it from read_file output, without line numbers) and be unique unless replace_all is true.',
    schema: z.object({
      path: z.string().describe('File path relative to the project root'),
      old_string: z.string().describe('Exact existing text to replace'),
      new_string: z.string().describe('Replacement text'),
      replace_all: optBool.describe('Replace every occurrence (default false)'),
    }),
    readOnly: false,
    describe: (a) => str(a.path),
    run: async (a, ctx) => {
      const { replacements, note } = editFile(ctx.workspace, a.path, a.old_string, a.new_string, a.replace_all ?? false);
      return {
        ok: true,
        output: `Edited ${a.path}: ${replacements} replacement(s) applied${note ? ` (${note}). Read the file to confirm the result` : ''}.`,
        summary: `${replacements} replacement(s)${note ? ' · re-indented' : ''}`,
      };
    },
  }),
  defineTool({
    name: 'delete_file',
    description: 'Delete a single file from the project. Requires user approval.',
    schema: z.object({ path: z.string().describe('File path relative to the project root') }),
    readOnly: false,
    describe: (a) => str(a.path),
    run: async (a, ctx) => {
      const abs = ctx.workspace.resolveWritable(a.path);
      const rel = ctx.workspace.relative(abs);
      const key = `delete:${rel}`;
      if (!ctx.policy.isAllowed(key)) {
        const decision = await ctx.requestApproval({
          kind: 'delete',
          title: `Delete file ${rel}?`,
          detail: rel,
          reason: 'Deleting files is destructive.',
        });
        if (decision === 'no') {
          return { ok: false, output: `The user denied deleting ${rel}. Do not retry; continue without deleting it.`, summary: 'denied by user' };
        }
        if (decision === 'always') ctx.policy.allow(key);
      }
      deleteFile(ctx.workspace, a.path);
      return { ok: true, output: `Deleted ${rel}.`, summary: 'deleted' };
    },
  }),
  defineTool({
    name: 'run_command',
    description:
      'Run a shell command in the project root (e.g. tests, builds, linters, package installs). Returns exit code and output. Non read-only commands require user approval; dangerous commands are blocked.',
    schema: z.object({
      command: z.string().min(1).describe('The shell command to run'),
      timeout_sec: z.coerce.number().int().min(1).max(1800).optional().describe('Timeout in seconds'),
    }),
    readOnly: false,
    describe: (a) => `$ ${str(a.command, 70)}`,
    run: async (a, ctx) => {
      const assessment = assessCommand(a.command);
      if (assessment.risk === 'blocked') {
        return {
          ok: false,
          output: `Command blocked by LocalLoom safety policy (${assessment.reason}). Do not attempt it again or work around it.`,
          summary: `blocked: ${assessment.reason}`,
        };
      }
      const hang = detectNeverExiting(a.command, ctx.workspace);
      if (hang) {
        const check = await checkFile(ctx.workspace.resolve(hang.file), hang.file, ctx.workspace.root);
        const checkText = check
          ? ` Instead it was syntax-checked with ${check.checker}: ${check.ok ? 'OK.' : `FAILED:\n${check.message}`}`
          : '';
        return {
          ok: check ? check.ok : true,
          output: `Not run: ${hang.file} is a program that does not exit on its own (${hang.why}), so running it would hang until the timeout. Do not try to run it again.${checkText}\nVerify its logic by reading the code, or test pure functions with a separate non-interactive script.`,
          summary: `not run (${hang.why})${check ? ` · syntax ${check.ok ? 'OK' : 'error'}` : ''}`,
        };
      }
      const key = `cmd:${a.command.trim()}`;
      if (assessment.risk === 'approval' && !ctx.policy.isAllowed(key)) {
        const decision = await ctx.requestApproval({
          kind: 'command',
          title: 'Run command?',
          detail: a.command,
          reason: assessment.reason,
        });
        if (decision === 'no') {
          return {
            ok: false,
            output: 'The user denied running this command. Do not retry it; continue without it or explain what the user should run.',
            summary: 'denied by user',
          };
        }
        if (decision === 'always') ctx.policy.allow(key);
      }
      const res = await runShellCommand(a.command, {
        cwd: ctx.workspace.root,
        timeoutSec: a.timeout_sec ?? ctx.config.commandTimeoutSec,
        shell: ctx.config.shell,
        signal: ctx.signal,
      });
      const status = res.aborted
        ? 'aborted'
        : res.timedOut
          ? `timed out after ${a.timeout_sec ?? ctx.config.commandTimeoutSec}s`
          : `exit code ${res.exitCode}`;
      return {
        ok: !res.aborted && !res.timedOut && res.exitCode === 0,
        output: `$ ${a.command}\n[${status}]\n${res.output || '(no output)'}`,
        summary: status,
      };
    },
  }),
];

const BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));

export function getTool(name: string): ToolDefinition | undefined {
  return BY_NAME.get(name) ?? BY_NAME.get(TOOL_ALIASES[name.toLowerCase()] ?? '');
}

/** Common names small models invent for our tools. */
const TOOL_ALIASES: Record<string, string> = {
  ls: 'list_dir',
  list_directory: 'list_dir',
  list_files: 'list_dir',
  cat: 'read_file',
  open_file: 'read_file',
  view_file: 'read_file',
  grep: 'search_code',
  search: 'search_code',
  search_files: 'search_code',
  glob: 'find_files',
  create_file: 'write_file',
  save_file: 'write_file',
  replace_in_file: 'edit_file',
  str_replace: 'edit_file',
  modify_file: 'edit_file',
  remove_file: 'delete_file',
  bash: 'run_command',
  shell: 'run_command',
  execute_command: 'run_command',
  run_terminal_command: 'run_command',
  terminal: 'run_command',
};

const ARG_ALIASES: Record<string, string> = {
  file_path: 'path',
  filepath: 'path',
  filename: 'path',
  file: 'path',
  dir: 'path',
  directory: 'path',
  contents: 'content',
  text: 'content',
  code: 'content',
  query: 'pattern',
  regex: 'pattern',
  search: 'pattern',
  old: 'old_string',
  old_text: 'old_string',
  oldstring: 'old_string',
  search_text: 'old_string',
  new: 'new_string',
  new_text: 'new_string',
  newstring: 'new_string',
  replace_text: 'new_string',
  replacement: 'new_string',
  cmd: 'command',
  start: 'start_line',
  end: 'end_line',
};

export function normalizeArgs(args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) {
    const key = ARG_ALIASES[k.toLowerCase()] ?? k;
    if (!(key in out)) out[key] = v;
  }
  return out;
}

export function toolSpecs(names: string[]): ToolSpec[] {
  return names
    .map((n) => BY_NAME.get(n))
    .filter((t): t is ToolDefinition => !!t)
    .map((t) => {
      const schema = z.toJSONSchema(t.schema, { io: 'input', unrepresentable: 'any' }) as Record<string, unknown>;
      delete schema.$schema;
      return { type: 'function' as const, function: { name: t.name, description: t.description, parameters: schema } };
    });
}

/** Compact textual tool documentation, used for models without native tool calling. */
export function toolDocs(names: string[]): string {
  return toolSpecs(names)
    .map((s) => {
      const props = (s.function.parameters.properties ?? {}) as Record<string, { type?: string; description?: string }>;
      const req = new Set((s.function.parameters.required as string[] | undefined) ?? []);
      const params = Object.entries(props)
        .map(([k, v]) => `${k}${req.has(k) ? '' : '?'}: ${v.type ?? 'any'}${v.description ? ` — ${v.description}` : ''}`)
        .join('; ');
      return `- ${s.function.name}(${params}): ${s.function.description}`;
    })
    .join('\n');
}

export interface ExecutedTool extends ToolOutput {
  name: string;
  args: Record<string, unknown>;
}

/** Validate arguments and run a tool, converting every failure into a result the model can learn from. */
export async function executeTool(
  name: string,
  rawArgs: Record<string, unknown>,
  ctx: ToolContext,
  allowed: string[],
): Promise<ExecutedTool> {
  const tool = getTool(name);
  const args = normalizeArgs(rawArgs ?? {});
  if (!tool) {
    return {
      name,
      args,
      ok: false,
      output: `Unknown tool "${name}". Available tools: ${allowed.join(', ')}.`,
      summary: 'unknown tool',
    };
  }
  if (!allowed.includes(tool.name)) {
    return {
      name: tool.name,
      args,
      ok: false,
      output: `Tool "${tool.name}" is not available to you. Available tools: ${allowed.join(', ')}.`,
      summary: 'not permitted for this agent',
    };
  }
  const parsed = tool.schema.safeParse(args);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.') || 'args'}: ${i.message}`).join('; ');
    return { name: tool.name, args, ok: false, output: `Invalid arguments for ${tool.name}: ${issues}`, summary: 'invalid arguments' };
  }
  try {
    const out = await tool.run(parsed.data as never, ctx);
    return { name: tool.name, args, ...out };
  } catch (err) {
    const message = (err as Error).message ?? String(err);
    return { name: tool.name, args, ok: false, output: `Error: ${message}`, summary: message.slice(0, 80) };
  }
}
