#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { render } from 'ink';
import { APP_NAME, APP_VERSION, loadConfig, normalizeHost } from './config.js';
import { Session } from './core/session.js';
import { OllamaClient } from './ollama/client.js';
import { App } from './ui/App.js';

const HELP = `${APP_NAME} v${APP_VERSION} — local multi-agent AI coding assistant (Ollama)

Usage:
  localloom [options] [directory]

Runs in the current directory (or [directory]) and uses it as the project workspace.

Options:
  -m, --model <name>    Start in Manual mode with this Ollama model for all agents
  -a, --auto            Start in Auto mode (default)
  -p, --prompt <text>   Run this task immediately after start-up
  -y, --yes             Auto-approve commands and deletions (dangerous commands stay blocked)
      --host <url>      Ollama server URL (default: $OLLAMA_HOST or http://127.0.0.1:11434)
  -h, --help            Show this help
  -v, --version         Show version

Environment:
  OLLAMA_HOST                  Ollama server address
  LOCALLOOM_ROUTER_MODEL       Model used by the Auto-mode router (default: smallest installed)
  LOCALLOOM_NUM_CTX            Context window requested from Ollama (default 16384)
  LOCALLOOM_MAX_STEPS          Max tool steps per agent turn (default 24)
  LOCALLOOM_MAX_REVIEW_CYCLES  Max review→fix cycles (default 3)
  LOCALLOOM_COMMAND_TIMEOUT    Command timeout in seconds (default 120)
  LOCALLOOM_SHELL              Shell used for commands (default: cmd.exe on Windows, /bin/sh elsewhere)

In the app, type /help for commands.`;

interface CliArgs {
  model?: string;
  auto?: boolean;
  prompt?: string;
  yes?: boolean;
  host?: string;
  dir?: string;
}

function parseArgs(argv: string[]): CliArgs {
  const out: CliArgs = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const next = () => {
      const v = argv[++i];
      if (v === undefined) fail(`Missing value for ${a}`);
      return v!;
    };
    switch (a) {
      case '-h':
      case '--help':
        console.log(HELP);
        process.exit(0);
      case '-v':
      case '--version':
        console.log(APP_VERSION);
        process.exit(0);
      case '-m':
      case '--model':
        out.model = next();
        break;
      case '-a':
      case '--auto':
        out.auto = true;
        break;
      case '-p':
      case '--prompt':
        out.prompt = next();
        break;
      case '-y':
      case '--yes':
        out.yes = true;
        break;
      case '--host':
        out.host = next();
        break;
      default:
        if (a.startsWith('-')) fail(`Unknown option: ${a}\n\n${HELP}`);
        out.dir = a;
    }
  }
  return out;
}

function fail(msg: string): never {
  console.error(msg);
  process.exit(1);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cwd = path.resolve(args.dir ?? process.cwd());
  if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) fail(`Not a directory: ${cwd}`);
  if (!process.stdin.isTTY) fail(`${APP_NAME} needs an interactive terminal (TTY).`);

  const config = loadConfig({
    ...(args.host ? { ollamaHost: normalizeHost(args.host) } : {}),
    ...(args.yes ? { autoApprove: true } : {}),
  });
  const client = new OllamaClient(config.ollamaHost);
  const session = new Session({ client, config, cwd });

  if (args.model) {
    try {
      await session.refreshModels();
      session.setManualModel(args.model);
    } catch (err) {
      fail(`${(err as Error).message}`);
    }
  }
  if (args.auto) session.mode = 'auto';

  const instance = render(<App session={session} initialPrompt={args.prompt} />, { exitOnCtrlC: false });
  await instance.waitUntilExit();
  process.stdout.write('\nGoodbye from LocalLoom.\n');
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
