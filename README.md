# LocalLoom

**A fully local, multi-agent AI coding assistant for your terminal.** LocalLoom runs four specialised agents (Planner, Coder, Reviewer and Fixer) on models served by [Ollama](https://ollama.com). No cloud APIs are involved; every model call stays on your machine.

```
localloom
```

### Project folders

LocalLoom creates a `LocalLoom Projects` folder in the directory it is started in. Each new project request ("make a calculator app…") gets its own folder there, named after the request (`calculator-app`; a taken name becomes `calculator-app (1)`). Follow-up requests keep working in the same folder; `/new` starts another one.

Inside the project folder the agents can freely read, create, edit and delete files and create folders. They cannot leave it: file tools reject paths outside the folder, and commands that point outside it are refused. Commands that are not read-only still ask for approval.

To work on an existing project in place instead, run `localloom --here` inside it.

### Chat history

Every conversation is saved automatically on your machine, so you can come back to it later. Type `/session` to open the list of saved chats (newest first), pick one with `↑/↓` and press `enter` to resume it: the transcript is shown again, the agents get the earlier context back, and they continue in that chat's project folder. `d` (pressed twice) deletes a chat. `/session 2` opens the second chat in the list directly, and `/session <id>` opens one by its id.

Chats are stored only locally, one JSON file per chat, in `~/.localloom/sessions` (on Windows `C:\Users\<you>\.localloom\sessions`). Nothing is uploaded. Set `LOCALLOOM_HISTORY_DIR` to keep them somewhere else, or `LOCALLOOM_NO_HISTORY=1` to not save chats at all. `/clear` starts a new chat; the cleared one stays in the history.

### Coding on Groq (optional)

Local models on a laptop GPU are slow at writing code. You can hand just the coding to [Groq](https://groq.com) while everything else stays local:

```bash
export GROQ_API_KEY=gsk_...        # PowerShell: $env:GROQ_API_KEY = "gsk_..."
localloom --groq                   # or --groq=llama-3.3-70b-versatile, or /groq inside the app
```

In Auto mode the Coder and Fixer then run on Groq (by default the best coding model Groq offers), while the router, Planner and Reviewer stay on your Ollama models. Groq models also appear in `/models` as `groq/<model>`, so in Manual mode you can assign them to any agent yourself.

Note that the code the Coder reads and writes is sent to Groq. Without `--groq` (or `/groq`), nothing leaves your machine, even when `GROQ_API_KEY` is set. Rate limits are retried automatically; if Groq says a request is too large for your plan, lower `LOCALLOOM_GROQ_NUM_CTX`. Set `LOCALLOOM_GROQ_CODING=1` to turn Groq coding on at every start.

## Features

- **Local chat history**: every chat is saved on your machine and can be resumed with `/session`.
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

Chat history needs no setup: the first time you send a message, LocalLoom creates `~/.localloom/sessions` and saves chats there. To store them elsewhere, set `LOCALLOOM_HISTORY_DIR` before starting:

```bash
export LOCALLOOM_HISTORY_DIR=~/localloom-chats   # PowerShell: $env:LOCALLOOM_HISTORY_DIR = "D:\localloom-chats"
```

## Usage

```
localloom [options] [directory]

  -m, --model <name>    Start in Manual mode with this model for all agents
  -a, --auto            Start in Auto mode (default)
  -p, --prompt <text>   Run a task immediately after start-up
      --here            Work directly in the directory instead of a project folder
      --groq[=model]    Run the Coder and Fixer on Groq (needs GROQ_API_KEY)
  -y, --yes             Auto-approve commands (dangerous commands stay blocked)
      --host <url>      Ollama URL (default $OLLAMA_HOST or http://127.0.0.1:11434)
```

### Commands

| Command | Description |
| --- | --- |
| `/models [name]` | Open the model picker (or set a model directly) |
| `/auto` | Enable Auto mode (SLM routing) |
| `/manual [name]` | Enable Manual mode |
| `/groq [model]` | Toggle running the Coder and Fixer on Groq, or pick the Groq model |
| `/new` | Start a new project folder with the next request |
| `/session [n\|id]` | Browse saved chats and resume one (aliases `/sessions`, `/history`, `/resume`) |
| `/agents` | Show agents, their models, tools and status |
| `/approve` | Toggle auto-approval of commands and deletions |
| `/clear` | Clear the screen and start a new chat (the old one stays in the history) |
| `/help` | Show commands and keys |
| `/exit` | Exit |

### Keys

`enter` sends · `tab` completes a command (or toggles Auto/Manual when the input is empty) · `↑/↓` history and lists · `esc` cancels the running task or closes dialogs · `ctrl+c` cancels, or exits when idle.

In the model picker, `tab` / `←→` chooses which agent the model is assigned to. In the chat history (`/session`), `enter` opens a chat and `d` twice deletes it.

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
| `LOCALLOOM_HISTORY_DIR` | `~/.localloom/sessions` | Folder where chats are saved (local only) |
| `LOCALLOOM_NO_HISTORY` | unset | Set to `1` to not save chats |
| `LOCALLOOM_DEBUG_LOG` | unset | Append every model request/response to this file (JSON lines), useful for diagnosing a model |

## How it works

```
user task ──► Router (Auto: SLM picks models per agent; Manual: your choice)
          ──► Planner   explores read-only, answers questions or writes a plan (+ JSON)
          ──► Coder     implements with tools; nudged if it only prints code
          ──► Reviewer  gets the plan + unified diff, may run tests → JSON verdict
          ──► Fixer     fixes reported issues ──► Reviewer … (≤ N cycles)
```

Approvals and model choices live in memory only. The conversation (transcript and the context the agents see) is saved to the local chat history after every change, so it can be resumed with `/session`; nothing is sent anywhere.

## Development

```bash
npm run build      # compile to dist/
npm test           # vitest
npm run typecheck
```

Source layout: `src/ollama` (client, model profiling), `src/router` (Auto mode), `src/agents` (definitions, runner, tool-call parsing), `src/tools` (workspace sandbox, file tools, command safety), `src/core/session.ts` (orchestration), `src/core/history.ts` (local chat history), `src/ui` (Ink TUI), `src/cli.tsx` (entry point).
