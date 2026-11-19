import { Box, Static, useApp, useInput, useStdout } from 'ink';
import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import { AGENT_ROLES, type AgentRole, type LoomEvent } from '../agents/events.js';
import type { Session } from '../core/session.js';
import { usableModels } from '../ollama/modelProfile.js';
import type { ApprovalDecision, ApprovalRequest } from '../tools/registry.js';
import { parseCommand } from './commands.js';
import { AgentBar, LivePanel, StatusBar } from './components/Activity.js';
import { ApprovalDialog } from './components/ApprovalDialog.js';
import { MessageItem } from './components/MessageItem.js';
import { ModelPicker } from './components/ModelPicker.js';
import { PromptInput } from './components/PromptInput.js';
import { SessionPicker } from './components/SessionPicker.js';
import { HISTORY_VERSION, newSessionId, titleFor, type HistoryStore, type SessionSummary, type StoredItem } from '../core/history.js';
import { initialState, persistableItems, reducer, type NewChatItem } from './state.js';

type Overlay =
  | { kind: 'models' }
  | { kind: 'approval'; request: ApprovalRequest }
  | { kind: 'sessions'; sessions: SessionSummary[] }
  | null;

function shortPath(p: string): string {
  const home = process.env.HOME || process.env.USERPROFILE;
  let out = home && p.toLowerCase().startsWith(home.toLowerCase()) ? `~${p.slice(home.length)}` : p;
  if (out.length > 40) out = `…${out.slice(-39)}`;
  return out;
}

export function App({ session, initialPrompt, history }: { session: Session; initialPrompt?: string; history?: HistoryStore }) {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const [state, dispatch] = useReducer(reducer, undefined, initialState);
  const [overlay, setOverlay] = useState<Overlay>(null);
  const [, rerender] = useReducer((x: number) => x + 1, 0);
  const [connected, setConnected] = useState<boolean | undefined>(undefined);
  const [modelsError, setModelsError] = useState<string | undefined>();
  const [tick, setTick] = useState(0);
  const [staticKey, setStaticKey] = useState(0);
  const [size, setSize] = useState({ cols: stdout.columns || 100, rows: stdout.rows || 30 });
  const buf = useRef({ text: '', thinking: '', dirty: false });
  const abortRef = useRef<AbortController | null>(null);
  const approvalRef = useRef<((d: ApprovalDecision) => void) | null>(null);
  const busyRef = useRef(false);
  busyRef.current = state.busy;
  /** The saved chat this conversation is written to (a new file per conversation). */
  const chatRef = useRef({ id: newSessionId(), createdAt: new Date().toISOString() });
  const saveFailed = useRef(false);

  const push = useCallback((item: NewChatItem) => dispatch({ type: 'push', item }), []);
  const notice = useCallback(
    (level: 'info' | 'success' | 'warn' | 'error', text: string) => push({ kind: 'notice', level, text }),
    [push],
  );

  useEffect(() => {
    const onResize = () => setSize({ cols: stdout.columns || 100, rows: stdout.rows || 30 });
    stdout.on('resize', onResize);
    return () => {
      stdout.off('resize', onResize);
    };
  }, [stdout]);

  const loadModels = useCallback(
    async (announce: boolean) => {
      try {
        const models = await session.refreshModels();
        setConnected(true);
        setModelsError(undefined);
        const usable = usableModels(models);
        if (!announce && session.groqError) notice('warn', `Groq models unavailable: ${session.groqError}`);
        if (!usable.length) {
          notice('warn', 'Ollama is running but no chat models are installed. Pull one, e.g. `ollama pull qwen2.5-coder:7b`, then run /models.');
        } else if (announce) {
          const local = usable.filter((m) => !m.provider || m.provider === 'ollama');
          const groqCount = usable.length - local.length;
          notice(
            'info',
            session.mode === 'auto'
              ? `Auto mode · ${local.length} local model${local.length === 1 ? '' : 's'} available (${local.map((m) => m.name).join(', ')})${groqCount ? ` + ${groqCount} Groq` : ''}`
              : `Manual mode · ${session.manualAssignment()?.coder}`,
          );
          if (session.groqError) notice('warn', `Groq models unavailable: ${session.groqError}`);
          if (session.groqCoding) {
            const g = session.groqCoder();
            notice(g ? 'info' : 'warn', g ? `Groq coding ON · Coder and Fixer → ${g.name} (code is sent to Groq) · /groq to turn off` : 'Groq coding is on, but no Groq model is available.');
          }
        }
        rerender();
        return models;
      } catch (err) {
        setConnected(false);
        const msg = (err as Error).message;
        setModelsError(msg);
        notice('error', msg);
        return [];
      }
    },
    [session, notice],
  );

  // Save the conversation to the local history whenever it changes (once it has a user message).
  useEffect(() => {
    if (!history) return;
    const items = persistableItems(state.items) as unknown as StoredItem[];
    if (!items.some((i) => i.kind === 'user')) return;
    try {
      history.save({
        version: HISTORY_VERSION,
        id: chatRef.current.id,
        title: titleFor(items),
        createdAt: chatRef.current.createdAt,
        updatedAt: new Date().toISOString(),
        cwd: process.cwd(),
        mode: session.mode,
        items,
        ...session.snapshot(),
      });
      saveFailed.current = false;
    } catch (err) {
      if (!saveFailed.current) notice('warn', `Could not save chat history to ${history.dir}: ${(err as Error).message}`);
      saveFailed.current = true;
    }
  }, [history, state.items, session, notice]);

  // Startup
  useEffect(() => {
    void loadModels(true).then(() => {
      if (initialPrompt) handleSubmit(initialPrompt);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Animation + stream flush loop while busy.
  useEffect(() => {
    if (!state.busy) return;
    const t = setInterval(() => {
      setTick((x) => x + 1);
      if (buf.current.dirty) {
        buf.current.dirty = false;
        dispatch({ type: 'live', text: buf.current.text, thinking: buf.current.thinking });
      }
    }, 90);
    return () => clearInterval(t);
  }, [state.busy]);

  const onEvent = useCallback((e: LoomEvent) => {
    switch (e.type) {
      case 'agent:content':
        buf.current.text += e.delta;
        buf.current.dirty = true;
        return;
      case 'agent:thinking':
        buf.current.thinking += e.delta;
        buf.current.dirty = true;
        return;
      case 'agent:start':
      case 'agent:step':
      case 'agent:message':
      case 'tool:start':
      case 'task:end':
        buf.current = { text: '', thinking: '', dirty: false };
        break;
    }
    dispatch({ type: 'event', event: e });
  }, []);

  const requestApproval = useCallback((request: ApprovalRequest) => {
    return new Promise<ApprovalDecision>((resolve) => {
      approvalRef.current = resolve;
      setOverlay({ kind: 'approval', request });
    });
  }, []);

  const decide = useCallback(
    (d: ApprovalDecision) => {
      const r = approvalRef.current;
      approvalRef.current = null;
      setOverlay(null);
      r?.(d);
    },
    [],
  );

  const cancel = useCallback(() => {
    if (!abortRef.current || abortRef.current.signal.aborted) return;
    abortRef.current.abort();
    if (approvalRef.current) decide('no');
    notice('warn', 'Cancelling…');
  }, [decide, notice]);

  const startTask = useCallback(
    (task: string) => {
      const ac = new AbortController();
      abortRef.current = ac;
      buf.current = { text: '', thinking: '', dirty: false };
      dispatch({ type: 'busy', busy: true });
      void session
        .runTask(task, onEvent, requestApproval, ac.signal)
        .catch((err) => notice('error', (err as Error).message))
        .finally(() => {
          abortRef.current = null;
          dispatch({ type: 'busy', busy: false });
          rerender();
        });
    },
    [session, onEvent, requestApproval, notice],
  );

  const toggleMode = useCallback(() => {
    if (session.mode === 'auto') {
      const a = session.manualAssignment();
      session.mode = 'manual';
      notice('info', a ? `Manual mode · ${a.coder} (change with /models)` : 'Manual mode · no models installed');
    } else {
      session.mode = 'auto';
      notice('info', 'Auto mode · the local router will assign models per task');
    }
    rerender();
  }, [session, notice]);

  const openSession = useCallback(
    (id: string) => {
      if (!history) return;
      if (busyRef.current) {
        notice('warn', 'Agents are still working. Press esc to cancel the current task before switching chats.');
        return;
      }
      let record;
      try {
        record = history.load(id);
      } catch (err) {
        notice('error', `Could not open chat ${id}: ${(err as Error).message}`);
        return;
      }
      setOverlay(null);
      stdout.write('\x1b[2J\x1b[3J\x1b[H');
      const warning = session.restore(record);
      if (record.mode === 'auto' || record.mode === 'manual') session.mode = record.mode;
      chatRef.current = { id: record.id, createdAt: record.createdAt };
      dispatch({ type: 'load', items: record.items as unknown as NewChatItem[] });
      setStaticKey((k) => k + 1);
      notice('success', `Resumed chat “${record.title}” — new messages continue this conversation.`);
      if (warning) notice('warn', warning);
      rerender();
    },
    [history, notice, session, stdout],
  );

  const runCommand = useCallback(
    (name: string, args: string) => {
      switch (name) {
        case '/session': {
          if (!history) {
            notice('info', 'Chat history is turned off (LOCALLOOM_NO_HISTORY=1).');
            return;
          }
          if (args) {
            const found = history.resolve(args);
            if (!found) notice('error', `No saved chat matches "${args}". Type /session to browse them.`);
            else openSession(found.id);
            return;
          }
          setOverlay({ kind: 'sessions', sessions: history.list() });
          return;
        }
        case '/help':
          push({ kind: 'help' });
          return;
        case '/exit':
          abortRef.current?.abort();
          exit();
          return;
        case '/groq': {
          if (!session.config.groqApiKey) {
            notice('error', 'Groq is not set up. Set the GROQ_API_KEY environment variable and restart LocalLoom.');
            return;
          }
          if (args) {
            const want = args.replace(/^groq\//, '');
            const m = session.groqModels.find((x) => x.name.toLowerCase() === `groq/${want.toLowerCase()}`);
            if (!m) {
              notice('error', `Groq has no model "${want}". Available: ${session.groqModels.map((x) => x.name.slice(5)).join(', ') || '(none — run /models to refresh)'}`);
              return;
            }
            session.groqModel = want;
            session.groqCoding = true;
          } else {
            session.groqCoding = !session.groqCoding;
          }
          if (session.groqCoding) {
            const g = session.groqCoder();
            if (session.mode !== 'auto') session.mode = 'auto';
            notice(
              g ? 'success' : 'warn',
              g
                ? `Groq coding ON · Auto mode, Coder and Fixer → ${g.name}; router, Planner and Reviewer stay local. The code the Coder works on is sent to Groq.`
                : `Groq coding ON, but no Groq models are listed${session.groqError ? ` (${session.groqError})` : ''}. Run /models to refresh.`,
            );
          } else {
            notice('success', 'Groq coding OFF · every agent runs on local models.');
          }
          rerender();
          return;
        }
        case '/undo': {
          if (busyRef.current) {
            notice('warn', 'Agents are still working. Press esc to cancel the current task before undoing.');
            return;
          }
          const force = /^(--)?force$/i.test(args);
          if (args && !force) {
            notice('error', `Unknown option "${args}". Use /undo, or /undo force to overwrite files you changed afterwards.`);
            return;
          }
          const list = (files: string[]) => (files.length > 6 ? `${files.slice(0, 6).join(', ')} and ${files.length - 6} more` : files.join(', '));
          const quote = (task: string) => `“${task.length > 60 ? `${task.slice(0, 59)}…` : task}”`;
          let result;
          try {
            result = session.undo({ force });
          } catch (err) {
            notice('error', `Undo failed: ${(err as Error).message}`);
            return;
          }
          if (result.status === 'nothing') {
            notice('info', 'Nothing to undo: no request in this chat has changed files yet (or every change was already undone).');
            return;
          }
          if (result.status === 'conflict') {
            notice(
              'warn',
              `Not undone: ${list(result.conflicts)} changed after ${quote(result.task)}. Undoing would discard those edits — type /undo force to do it anyway.`,
            );
            return;
          }
          const parts = [
            result.restored.length && `restored ${list(result.restored)}`,
            result.deleted.length && `removed ${list(result.deleted)}`,
          ].filter(Boolean);
          notice('success', `Undid ${quote(result.task)} — ${parts.join('; ') || 'only empty folders were removed'}.`);
          if (result.removedProject) notice('info', 'Its project folder was empty afterwards and has been removed; your next request will start a new project.');
          if (result.failed.length) notice('error', `Could not revert ${list(result.failed)} (in use or not writable).`);
          if (!result.complete) notice('warn', 'That folder was too large to snapshot, so changes made by commands were not reverted.');
          if (result.remaining) notice('info', `${result.remaining} earlier request${result.remaining === 1 ? '' : 's'} can still be undone.`);
          rerender();
          return;
        }
        case '/new':
          if (!session.projectsRoot) {
            notice('info', 'Started with --here: LocalLoom works directly in this directory, so there are no project folders.');
            return;
          }
          session.newProject();
          notice('success', 'Your next request will start a new project folder.');
          return;
        case '/agents':
          push({ kind: 'agents' });
          return;
        case '/clear':
          stdout.write('\x1b[2J\x1b[3J\x1b[H');
          session.clearMemory();
          // The cleared chat stays in the history; anything typed next is a new chat.
          chatRef.current = { id: newSessionId(), createdAt: new Date().toISOString() };
          dispatch({ type: 'clear' });
          setStaticKey((k) => k + 1);
          return;
        case '/approve':
          session.policy.autoApprove = !session.policy.autoApprove;
          notice(
            session.policy.autoApprove ? 'warn' : 'success',
            session.policy.autoApprove
              ? 'Auto-approve ON — commands and deletions run without asking (dangerous commands stay blocked).'
              : 'Auto-approve OFF — you will be asked before commands and deletions.',
          );
          rerender();
          return;
        case '/auto':
          session.mode = 'auto';
          notice(
            'success',
            session.usable.length > 1
              ? `Auto mode enabled · a local router model will assign one of ${session.usable.length} installed models to each agent.`
              : 'Auto mode enabled · only one chat model is installed, so all agents will use it. Install more models for smarter routing.',
          );
          rerender();
          return;
        case '/manual':
        case '/models': {
          if (args) {
            try {
              const m = session.setManualModel(args);
              notice('success', `Manual mode · all agents now use ${m.name}`);
              rerender();
            } catch (err) {
              notice('error', (err as Error).message);
            }
            return;
          }
          if (name === '/manual') {
            session.mode = 'manual';
            const a = session.manualAssignment();
            if (!a) {
              notice('warn', 'Manual mode enabled, but no chat models are installed.');
            } else {
              const uniq = [...new Set(Object.values(a))];
              notice('success', `Manual mode enabled · ${uniq.length === 1 ? `all agents use ${uniq[0]}` : AGENT_ROLES.map((r) => `${r}: ${a[r]}`).join(', ')} · /models to change`);
            }
            rerender();
            return;
          }
          void loadModels(false).then(() => setOverlay({ kind: 'models' }));
          return;
        }
        default:
          notice('error', `Unknown command ${name}. Type /help for the list of commands.`);
      }
    },
    [exit, push, notice, session, stdout, loadModels, history, openSession],
  );

  const handleSubmit = useCallback(
    (text: string) => {
      const cmd = text.startsWith('/') ? parseCommand(text) : undefined;
      if (cmd) {
        runCommand(cmd.name, cmd.args);
        return;
      }
      if (busyRef.current) {
        notice('warn', 'Agents are still working. Press esc to cancel the current task first.');
        return;
      }
      if (connected === false) {
        notice('error', 'Ollama is not reachable. Start it with `ollama serve`, then run /models to reconnect.');
        return;
      }
      push({ kind: 'user', text });
      startTask(text);
    },
    [runCommand, notice, push, startTask, connected],
  );

  // Global keys
  useInput((input, key) => {
    if (key.ctrl && input === 'c') {
      if (overlay?.kind === 'approval') decide('no');
      if (busyRef.current) cancel();
      else exit();
      return;
    }
    if (key.escape && !overlay && busyRef.current) cancel();
  });

  const assignment = session.currentAssignment();
  const uniq = [...new Set(Object.values(assignment).filter(Boolean))] as string[];
  let modelLabel: string;
  if (session.mode === 'auto') {
    modelLabel = uniq.length ? (uniq.length === 1 ? uniq[0]! : `${uniq.length} models routed`) : `${session.usable.length} model${session.usable.length === 1 ? "" : "s"} · routed per task`;
  } else {
    modelLabel = uniq.length === 1 ? uniq[0]! : uniq.length ? AGENT_ROLES.map((r: AgentRole) => (assignment[r] ?? '?').split(':')[0]).join(' / ') : 'no model';
  }

  const elapsed = state.taskStart && state.busy ? Date.now() - state.taskStart : 0;
  const width = Math.max(40, size.cols - 1);
  const liveLines = Math.max(4, Math.min(18, size.rows - 14));

  return (
    <>
      <Static key={staticKey} items={state.items}>
        {(item) => (
          <Box key={item.id} width={width} flexDirection="column">
            <MessageItem item={item} session={session} statuses={state.agents} />
          </Box>
        )}
      </Static>
      <Box flexDirection="column" width={width}>
        {state.busy ? (
          <LivePanel
            agent={state.activeAgent}
            model={state.activeModel}
            text={state.liveText}
            thinking={state.liveThinking}
            tools={state.runningTools}
            routing={state.routing}
            tick={tick}
            width={width}
            maxLines={liveLines}
          />
        ) : null}
        {overlay?.kind === 'approval' ? <ApprovalDialog request={overlay.request} onDecide={decide} /> : null}
        {overlay?.kind === 'sessions' && history ? (
          <SessionPicker
            sessions={overlay.sessions}
            currentId={chatRef.current.id}
            dir={shortPath(history.dir)}
            onOpen={openSession}
            onClose={() => setOverlay(null)}
            onDelete={(id) => {
              history.delete(id);
              if (id === chatRef.current.id) chatRef.current = { id: newSessionId(), createdAt: new Date().toISOString() };
              setOverlay({ kind: 'sessions', sessions: history.list() });
            }}
          />
        ) : null}
        {overlay?.kind === 'models' ? (
          <ModelPicker
            models={session.usable}
            assignment={assignment}
            mode={session.mode}
            error={modelsError}
            groqNote={
              !session.config.groqApiKey
                ? 'Groq: no GROQ_API_KEY found. Set it, then start localloom again in a new terminal.'
                : session.groqError
                  ? `Groq: ${session.groqError}`
                  : session.groqModels.length
                    ? undefined
                    : 'Groq: no chat models returned. Press r to refresh.'
            }
            onClose={() => setOverlay(null)}
            onRefresh={() => void loadModels(false)}
            onAuto={() => {
              setOverlay(null);
              runCommand('/auto', '');
            }}
            onSelect={(model, target) => {
              try {
                const m = session.setManualModel(model, target);
                notice('success', `Manual mode · ${target === 'all' ? 'all agents' : target} → ${m.name}`);
              } catch (err) {
                notice('error', (err as Error).message);
              }
              setOverlay(null);
              rerender();
            }}
          />
        ) : null}
        <AgentBar agents={state.agents} tick={tick} elapsedMs={elapsed} busy={state.busy} phase={state.phase} />
        <PromptInput isActive={!overlay} busy={state.busy} width={width} onSubmit={handleSubmit} onEmptyTab={toggleMode} />
        <StatusBar
          cwd={shortPath(session.workspace.root)}
          mode={session.mode}
          modelLabel={modelLabel}
          autoApprove={session.policy.autoApprove}
          groq={session.mode === 'auto' && session.groqCoding ? session.groqCoder()?.name ?? 'unavailable' : undefined}
          connected={connected}
          busy={state.busy}
        />
      </Box>
    </>
  );
}
