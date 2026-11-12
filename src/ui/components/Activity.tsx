import { Box, Text } from 'ink';
import { AGENTS } from '../../agents/definitions.js';
import { AGENT_ROLES, type AgentRole } from '../../agents/events.js';
import type { AgentStatus, RunningTool } from '../state.js';
import { SPINNER, agentColor, theme } from '../theme.js';

function wrapTail(text: string, width: number, maxLines: number): string[] {
  const out: string[] = [];
  for (const raw of text.replace(/\r/g, '').split('\n')) {
    if (!raw) {
      out.push('');
      continue;
    }
    for (let i = 0; i < raw.length; i += width) out.push(raw.slice(i, i + width));
  }
  return out.slice(-maxLines);
}

export function LivePanel({
  agent,
  model,
  text,
  thinking,
  tools,
  routing,
  tick,
  width,
  maxLines,
}: {
  agent?: AgentRole;
  model?: string;
  text: string;
  thinking: string;
  tools: RunningTool[];
  routing: boolean;
  tick: number;
  width: number;
  maxLines: number;
}) {
  const spin = SPINNER[tick % SPINNER.length];
  if (routing) {
    return (
      <Box marginTop={1}>
        <Text color={theme.brand2}>
          {spin} Routing — the local router model is choosing models for each agent…
        </Text>
      </Box>
    );
  }
  if (!agent) return null;
  const trimmed = text.trimStart();
  const isToolJson = /^(\{|\[|<tool_call>|```json\s*\{)/.test(trimmed);
  const lines = isToolJson ? [] : wrapTail(text.trim(), Math.max(20, width - 4), maxLines);
  const a = AGENTS[agent];
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text>
        <Text color={agentColor[agent]} bold>
          {spin} {a.label}
        </Text>
        <Text color={theme.dim}> · {model}</Text>
      </Text>
      {thinking && !text ? (
        <Box paddingLeft={2}>
          <Text color={theme.dim} italic>
            thinking… {thinking.replace(/\s+/g, ' ').slice(-Math.max(20, width - 16))}
          </Text>
        </Box>
      ) : null}
      {isToolJson ? (
        <Box paddingLeft={2}>
          <Text color={theme.dim}>preparing tool call…</Text>
        </Box>
      ) : null}
      {lines.length ? (
        <Box paddingLeft={2} flexDirection="column">
          {lines.map((l, i) => (
            <Text key={i}>{l || ' '}</Text>
          ))}
        </Box>
      ) : null}
      {!text && !thinking && !tools.length ? (
        <Box paddingLeft={2}>
          <Text color={theme.dim}>waiting for model…</Text>
        </Box>
      ) : null}
      {tools.map((t) => (
        <Text key={t.id}>
          {'  '}
          <Text color={theme.warn}>{spin}</Text>
          <Text color={agentColor[t.agent]}> {t.name}</Text>
          <Text> {t.detail}</Text>
        </Text>
      ))}
    </Box>
  );
}

const STATE_ICON: Record<AgentStatus['state'], string> = {
  idle: '○',
  waiting: '○',
  working: '',
  done: '✓',
  error: '✗',
  skipped: '–',
};

export function AgentBar({
  agents,
  tick,
  elapsedMs,
  busy,
  phase,
}: {
  agents: Record<AgentRole, AgentStatus>;
  tick: number;
  elapsedMs: number;
  busy: boolean;
  phase?: string;
}) {
  const secs = Math.floor(elapsedMs / 1000);
  const elapsed = secs < 60 ? `${secs}s` : `${Math.floor(secs / 60)}m${String(secs % 60).padStart(2, '0')}s`;
  return (
    <Box marginTop={1} justifyContent="space-between">
      <Text>
        {AGENT_ROLES.map((r, i) => {
          const s = agents[r];
          const icon = s.state === 'working' ? SPINNER[tick % SPINNER.length] : STATE_ICON[s.state];
          const color =
            s.state === 'working'
              ? agentColor[r]
              : s.state === 'done'
                ? theme.success
                : s.state === 'error'
                  ? theme.error
                  : theme.dim;
          return (
            <Text key={r}>
              {i ? <Text color={theme.border}> │ </Text> : null}
              <Text color={color}>{icon} </Text>
              <Text color={s.state === 'working' ? agentColor[r] : s.state === 'idle' || s.state === 'waiting' || s.state === 'skipped' ? theme.dim : theme.text} bold={s.state === 'working'}>
                {AGENTS[r].label}
              </Text>
              {s.state === 'working' && s.step ? <Text color={theme.dim}> {s.step}/{s.maxSteps}</Text> : null}
              {s.note && s.state !== 'working' ? <Text color={theme.dim}> {s.note}</Text> : null}
            </Text>
          );
        })}
      </Text>
      {busy ? (
        <Text color={theme.dim}>
          {phase ? `${phase} · ` : ''}
          {elapsed}
        </Text>
      ) : null}
    </Box>
  );
}

export function StatusBar({
  cwd,
  mode,
  modelLabel,
  autoApprove,
  connected,
  busy,
}: {
  cwd: string;
  mode: 'auto' | 'manual';
  modelLabel: string;
  autoApprove: boolean;
  connected: boolean | undefined;
  busy: boolean;
}) {
  return (
    <Box justifyContent="space-between" paddingX={1}>
      <Text>
        <Text color={mode === 'auto' ? 'black' : 'black'} backgroundColor={mode === 'auto' ? theme.brand2 : theme.brand} bold>
          {` ${mode.toUpperCase()} `}
        </Text>
        <Text> </Text>
        <Text color={theme.text}>{modelLabel}</Text>
        {autoApprove ? <Text color={theme.warn}> · auto-approve</Text> : null}
        <Text color={theme.dim}> · </Text>
        <Text color={connected === false ? theme.error : connected ? theme.success : theme.dim}>
          {connected === false ? '● ollama offline' : connected ? '● ollama' : '○ ollama'}
        </Text>
        <Text color={theme.dim}> · {cwd}</Text>
      </Text>
      <Text color={theme.dim}>{busy ? 'esc cancel · ctrl+c cancel' : 'tab mode · /help · ctrl+c exit'}</Text>
    </Box>
  );
}
