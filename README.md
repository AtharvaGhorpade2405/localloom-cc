# LocalLoom

**A fully local, multi-agent AI coding assistant for your terminal.** LocalLoom runs four specialised agents (Planner, Coder, Reviewer and Fixer) on models served by [Ollama](https://ollama.com). It works on the project in your current directory. No cloud APIs are involved; every model call stays on your machine.

```
cd my-project
localloom
```

## Features

- **Polished TUI** (React + Ink): streaming responses, live agent activity bar, tool execution feedback, model/mode indicators, command palette with completion, keyboard navigation.
- **Local model selection**: auto-detects installed Ollama models. `/models` opens an interactive picker where you can assign a model to all agents or to each agent separately. You can switch models without restarting.
- **Four-agent pipeline**: Planner → Coder → Reviewer ⇄ Fixer, with a review-and-fix loop that is capped at a set number of cycles (and scaled by task complexity). Questions that need no file changes are answered by the Planner directly.
- **Auto mode (smart routing)**: a small local model (the smallest installed chat model, or `LOCALLOOM_ROUTER_MODEL`) classifies the task. It checks the installed models (size, coding/reasoning specialisation, tool support, context length) and assigns the best fit to each agent. Its output is validated against the installed models and never picks one that is not installed. If the router fails, a capability heuristic takes over.
- **Manual mode**: you pick the model(s).
- **Real coding tools**: list directories, read files, find files, search code, create/overwrite/edit files, delete files, run terminal commands. It handles changes across many files.
- **Safety**:
  - All file access is confined to the workspace, and symlinks that point outside it are rejected.
  - VCS internals can't be modified.
  - File deletion and any command that is not read-only need your approval (*once* / *always this session* / *deny*).
  - Destructive commands are always blocked: `rm -rf /`, `format`, `sudo`, `curl | sh`, force-push, registry edits and similar.
  - Commands have timeouts and can be cancelled with `esc`.
- Works with models that have native tool calling and with models that don't (for example `deepseek-coder-v2`):
  - Those models write files as raw `<write_file path="…">…</write_file>` blocks, so code never has to be escaped inside JSON.
  - Broken JSON calls are repaired automatically. Anything that still can't be parsed goes back to the model as an error, never silently dropped.
- Reasoning models' thinking is shown live.
- **Automatic verification**: after the Coder and after each Fixer pass, every changed Python/JS/JSON file is syntax-checked without running it. Failures are always treated as review issues, even if the Reviewer model approves. LocalLoom also refuses to launch programs that never exit (GUI apps such as tkinter, servers, interactive scripts) and syntax-checks them instead.

## Requirements

- Node.js ≥ 20
- [Ollama](https://ollama.com) running locally with at least one chat model, e.g.

```bash
ollama pull qwen2.5-coder:7b
```

For Auto mode to do real routing, install more than one model. A useful set: a small general model for routing (`llama3.2:3b` or `qwen2.5:3b`) and a coding model (`qwen2.5-coder:7b`/`14b`). A reasoning model such as `deepseek-r1` or `qwen3` can also help.

## Install

From this repository:

```bash
npm install
npm run build
npm install -g .
```

After that, `localloom` works in any directory.

## Usage

```
localloom [options] [directory]

  -m, --model <name>    Start in Manual mode with this model for all agents
  -a, --auto            Start in Auto mode (default)
  -p, --prompt <text>   Run a task immediately after start-up
  -y, --yes             Auto-approve commands/deletions (dangerous commands stay blocked)
      --host <url>      Ollama URL (default $OLLAMA_HOST or http://127.0.0.1:11434)
```

### Commands

| Command | Description |
| --- | --- |
| `/models [name]` | Open the model picker (or set a model directly) |
| `/auto` | Enable Auto mode (SLM routing) |
| `/manual [name]` | Enable Manual mode |
| `/agents` | Show agents, their models, tools and status |
| `/approve` | Toggle auto-approval of commands and deletions |
| `/clear` | Clear the screen and the in-memory conversation |
| `/help` | Show commands and keys |
| `/exit` | Exit |

### Keys

`enter` sends · `tab` completes a command (or toggles Auto/Manual when the input is empty) · `↑/↓` history and lists · `esc` cancels the running task or closes dialogs · `ctrl+c` cancels, or exits when idle.

In the model picker, `tab` / `←→` chooses which agent the model is assigned to.

### Environment variables

| Variable | Default | |
| --- | --- | --- |
| `OLLAMA_HOST` | `http://127.0.0.1:11434` | Ollama server |
| `LOCALLOOM_ROUTER_MODEL` | smallest installed | Router model for Auto mode |
| `LOCALLOOM_NUM_CTX` | `16384` | Context window requested (capped by the model) |
| `LOCALLOOM_MAX_STEPS` | `24` | Tool steps per agent turn |
| `LOCALLOOM_MAX_REVIEW_CYCLES` | `3` | Upper limit on review→fix cycles |
| `LOCALLOOM_COMMAND_TIMEOUT` | `120` | Command timeout (s) |
| `LOCALLOOM_SHELL` | `cmd.exe` / `/bin/sh` | Shell for commands |
| `LOCALLOOM_DEBUG_LOG` | unset | Append every model request/response to this file (JSON lines), useful for diagnosing a model |

## How it works

```
user task ──► Router (Auto: SLM picks models per agent; Manual: your choice)
          ──► Planner   explores read-only, answers questions or writes a plan (+ JSON)
          ──► Coder     implements with tools; nudged if it only prints code
          ──► Reviewer  gets the plan + unified diff, may run tests → JSON verdict
          ──► Fixer     fixes reported issues ──► Reviewer … (≤ N cycles)
```

State (conversation context, approvals, model choices) lives in memory only. Nothing is persisted.

## Development

```bash
npm run build      # compile to dist/
npm test           # vitest
npm run typecheck
```

Source layout: `src/ollama` (client, model profiling), `src/router` (Auto mode), `src/agents` (definitions, runner, tool-call parsing), `src/tools` (workspace sandbox, file tools, command safety), `src/core/session.ts` (orchestration), `src/ui` (Ink TUI), `src/cli.tsx` (entry point).
