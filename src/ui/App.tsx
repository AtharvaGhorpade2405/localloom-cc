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
import { initialState, reducer, type NewChatItem } from './state.js';

type Overlay = { kind: 'models' } | { kind: 'approval'; request: ApprovalRequest } | null;

function shortPath(p: string): string {
  const home = process.env.HOME || process.env.USERPROFILE;
  let out = home && p.toLowerCase().startsWith(home.toLowerCase()) ? `~${p.slice(home.length)}` : p;
  if (out.length > 40) out = `…${out.slice(-39)}`;
  return out;
}

export function App({ session, initialPrompt }: { session: Session; initialPrompt?: string }) {
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
        if (!usable.length) {
          notice('warn', 'Ollama is running but no chat models are installed. Pull one, e.g. `ollama pull qwen2.5-coder:7b`, then run /models.');
        } else if (announce) {
          notice(
            'info',
            session.mode === 'auto'
              ? `Auto mode · ${usable.length} local model${usable.length === 1 ? '' : 's'} available (${usable.map((m) => m.name).join(', ')})`
              : `Manual mode · ${session.manualAssignment()?.coder}`,
          );
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

  const runCommand = useCallback(
    (name: string, args: string) => {
      switch (name) {
        case '/help':
          push({ kind: 'help' });
          return;
        case '/exit':
          abortRef.current?.abort();
          exit();
          return;
        case '/agents':
          push({ kind: 'agents' });
          return;
        case '/clear':
          stdout.write('\x1b[2J\x1b[3J\x1b[H');
          session.clearMemory();
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
    [exit, push, notice, session, stdout, loadModels],
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
        {overlay?.kind === 'models' ? (
          <ModelPicker
            models={session.usable}
            assignment={assignment}
            mode={session.mode}
            error={modelsError}
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
          connected={connected}
          busy={state.busy}
        />
      </Box>
    </>
  );
}
