#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { render } from 'ink';
import { APP_NAME, APP_VERSION, loadConfig, normalizeHost, savedUserEnv } from './config.js';
import { defaultHistoryDir, historyDisabled, HistoryStore } from './core/history.js';
import { PROJECTS_DIR_NAME } from './core/projects.js';
import { Session } from './core/session.js';
import { MultiClient } from './core/multiClient.js';
import { GroqClient } from './groq/client.js';
import { OllamaClient } from './ollama/client.js';
import { App } from './ui/App.js';

const HELP = `${APP_NAME} v${APP_VERSION} — local multi-agent AI coding assistant (Ollama)

Usage:
  localloom [options] [directory]

Creates a "LocalLoom Projects" folder in the current directory (or [directory]). Every new project
request gets its own folder inside it, and the agents can only read, write, edit and delete there.

Options:
  -m, --model <name>    Start in Manual mode with this Ollama model for all agents
  -a, --auto            Start in Auto mode (default)
  -p, --prompt <text>   Run this task immediately after start-up
      --here            Work directly in the directory instead (edit an existing project in place)
  -y, --yes             Auto-approve commands (dangerous commands stay blocked)
      --groq[=model]    Auto mode: run the Coder and Fixer on Groq (needs GROQ_API_KEY); the rest stays local
      --host <url>      Ollama server URL (default: $OLLAMA_HOST or http://127.0.0.1:11434)
  -h, --help            Show this help
  -v, --version         Show version

Environment:
  OLLAMA_HOST                  Ollama server address
  GROQ_API_KEY                 Enables Groq models (listed as groq/<model> next to local ones)
  LOCALLOOM_GROQ_CODING        Set to 1 to always run the Coder and Fixer on Groq in Auto mode
  LOCALLOOM_GROQ_MODEL         Groq model for coding (default: the best coding model Groq offers)
  LOCALLOOM_GROQ_NUM_CTX       Context budget for Groq models (default: LOCALLOOM_NUM_CTX)
  LOCALLOOM_PROJECTS_DIR       Where project folders are created (default: ./LocalLoom Projects)
  LOCALLOOM_ROUTER_MODEL       Model used by the Auto-mode router (default: smallest installed)
  LOCALLOOM_NUM_CTX            Context window requested from Ollama (default 16384)
  LOCALLOOM_MAX_STEPS          Max tool steps per agent turn (default 24)
  LOCALLOOM_MAX_REVIEW_CYCLES  Max review→fix cycles (default 3)
  LOCALLOOM_COMMAND_TIMEOUT    Command timeout in seconds (default 120)
  LOCALLOOM_SHELL              Shell used for commands (default: cmd.exe on Windows, /bin/sh elsewhere)
  LOCALLOOM_HISTORY_DIR        Where chats are saved (default: ~/.localloom/sessions; local only)
  LOCALLOOM_NO_HISTORY         Set to 1 to not save chats at all

In the app, type /help for commands.`;

interface CliArgs {
  model?: string;
  auto?: boolean;
  prompt?: string;
  yes?: boolean;
  here?: boolean;
  groq?: boolean;
  groqModel?: string;
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
      case '--here':
        out.here = true;
        break;
      case '--groq':
        out.groq = true;
        break;
      case '--host':
        out.host = next();
        break;
      default:
        if (a.startsWith('--groq=')) {
          out.groq = true;
          out.groqModel = a.slice('--groq='.length);
          break;
        }
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
    ...(args.groq ? { groqCoding: true } : {}),
  });
  if (!config.groqApiKey) config.groqApiKey = savedUserEnv('GROQ_API_KEY');
  if (!process.env.LOCALLOOM_GROQ_CODING && savedUserEnv('LOCALLOOM_GROQ_CODING') === '1') config.groqCoding = true;
  if (args.groqModel) config.groqModel = args.groqModel.replace(/^groq\//, '');
  if (config.groqCoding && !config.groqApiKey) fail('--groq needs a Groq API key: set the GROQ_API_KEY environment variable first.');
  const client = new MultiClient(
    new OllamaClient(config.ollamaHost),
    config.groqApiKey ? new GroqClient({ apiKey: config.groqApiKey }) : undefined,
  );
  const projectsRoot = args.here ? undefined : path.resolve(process.env.LOCALLOOM_PROJECTS_DIR || path.join(cwd, PROJECTS_DIR_NAME));
  let session: Session;
  try {
    session = new Session({ client, config, cwd, projectsRoot });
  } catch (err) {
    fail(`Could not create the projects folder (${projectsRoot}): ${(err as Error).message}`);
  }

  if (args.model) {
    try {
      await session.refreshModels();
      session.setManualModel(args.model);
    } catch (err) {
      fail(`${(err as Error).message}`);
    }
  }
  if (args.auto) session.mode = 'auto';

  const history = historyDisabled() ? undefined : new HistoryStore(defaultHistoryDir());
  const instance = render(<App session={session} initialPrompt={args.prompt} history={history} />, { exitOnCtrlC: false });
  await instance.waitUntilExit();
  process.stdout.write('\nGoodbye from LocalLoom.\n');
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
