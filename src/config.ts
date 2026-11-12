import os from 'node:os';

function intEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export const APP_NAME = 'LocalLoom';
export const APP_VERSION = '0.1.0';

export interface LocalLoomConfig {
  /** Base URL of the local Ollama server. */
  ollamaHost: string;
  /** Context window requested from Ollama (capped by the model's own limit). */
  numCtx: number;
  /** Maximum tool-using steps a single agent may take in one turn. */
  maxAgentSteps: number;
  /** Upper bound on review → fix cycles. */
  maxReviewCycles: number;
  /** Optional explicit router (SLM) model. */
  routerModel?: string;
  /** Timeout for terminal commands, in seconds. */
  commandTimeoutSec: number;
  /** Auto-approve non-blocked commands and deletions. */
  autoApprove: boolean;
  /** Shell used for run_command. */
  shell: string | true;
  platform: NodeJS.Platform;
}

export function normalizeHost(host: string): string {
  let h = host.trim();
  if (!/^https?:\/\//i.test(h)) h = `http://${h}`;
  // 0.0.0.0 is a bind address, not something we can connect to.
  h = h.replace('://0.0.0.0', '://127.0.0.1');
  return h.replace(/\/+$/, '');
}

export function loadConfig(overrides: Partial<LocalLoomConfig> = {}): LocalLoomConfig {
  const base: LocalLoomConfig = {
    ollamaHost: normalizeHost(process.env.OLLAMA_HOST || 'http://127.0.0.1:11434'),
    numCtx: intEnv('LOCALLOOM_NUM_CTX', 16384),
    maxAgentSteps: intEnv('LOCALLOOM_MAX_STEPS', 24),
    maxReviewCycles: intEnv('LOCALLOOM_MAX_REVIEW_CYCLES', 3),
    routerModel: process.env.LOCALLOOM_ROUTER_MODEL || undefined,
    commandTimeoutSec: intEnv('LOCALLOOM_COMMAND_TIMEOUT', 120),
    autoApprove: process.env.LOCALLOOM_AUTO_APPROVE === '1',
    shell: process.env.LOCALLOOM_SHELL || true,
    platform: os.platform(),
  };
  return { ...base, ...overrides };
}

export function describeShell(config: LocalLoomConfig): string {
  if (typeof config.shell === 'string') return config.shell;
  return config.platform === 'win32' ? 'cmd.exe' : '/bin/sh';
}
