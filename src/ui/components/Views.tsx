import { Box, Text } from 'ink';
import { AGENTS } from '../../agents/definitions.js';
import { AGENT_ROLES } from '../../agents/events.js';
import { APP_VERSION } from '../../config.js';
import type { Session } from '../../core/session.js';
import { describeModel, formatBytes, profileModel } from '../../ollama/modelProfile.js';
import type { RoutingResult } from '../../router/router.js';
import { COMMANDS } from '../commands.js';
import type { AgentStatus } from '../state.js';
import { agentColor, theme } from '../theme.js';

export function Banner({ cwd }: { cwd: string }) {
  const logo = ['█   █▀█ █▀▀ ▄▀█ █   █   █▀█ █▀█ █▀▄▀█', '█▄▄ █▄█ █▄▄ █▀█ █▄▄ █▄▄ █▄█ █▄█ █ ▀ █'];
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box flexDirection="column" marginTop={1}>
        <Text color={theme.brand}>{logo[0]}</Text>
        <Text color={theme.brand2}>{logo[1]}</Text>
      </Box>
      <Text>
        <Text color={theme.dim}>v{APP_VERSION} · local multi-agent coding · </Text>
        <Text color={theme.text}>{cwd}</Text>
      </Text>
      <Text color={theme.dim}>
        Describe a task, or type <Text color={theme.accent}>/help</Text> for commands · <Text color={theme.accent}>/models</Text> to pick a model · <Text color={theme.accent}>/auto</Text> for smart routing
      </Text>
    </Box>
  );
}

export function HelpView() {
  const keys: [string, string][] = [
    ['enter', 'send message / run command'],
    ['tab', 'complete command · toggle auto/manual when input is empty'],
    ['↑ / ↓', 'input history · navigate lists'],
    ['esc', 'cancel running task · close dialogs'],
    ['ctrl+c', 'cancel task, or exit when idle'],
    ['ctrl+u / ctrl+w', 'clear line / delete word'],
  ];
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.border} paddingX={1} marginY={1}>
      <Text bold color={theme.brand}>Commands</Text>
      {COMMANDS.map((c) => (
        <Text key={c.name}>
          <Text color={theme.accent}>{`${c.name}${c.args ? ` ${c.args}` : ''}`.padEnd(20)}</Text>
          <Text color={theme.dim}>{c.description}</Text>
        </Text>
      ))}
      <Box marginTop={1} />
      <Text bold color={theme.brand}>Keys</Text>
      {keys.map(([k, d]) => (
        <Text key={k}>
          <Text color={theme.info}>{k.padEnd(20)}</Text>
          <Text color={theme.dim}>{d}</Text>
        </Text>
      ))}
      <Box marginTop={1} />
      <Text color={theme.dim}>
        Workflow: Planner → Coder → Reviewer ⇄ Fixer. All inference runs locally in Ollama. Each project gets its own folder in "LocalLoom Projects"; agents cannot touch anything outside it.
      </Text>
    </Box>
  );
}

export function AgentsView({ session, statuses }: { session: Session; statuses: Record<string, AgentStatus> }) {
  const assignment = session.currentAssignment();
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.border} paddingX={1} marginY={1}>
      <Text>
        <Text bold color={theme.brand}>Agents</Text>
        <Text color={theme.dim}> · mode </Text>
        <Text bold>{session.mode.toUpperCase()}</Text>
        {session.mode === 'auto' && !session.lastRouting ? (
          <Text color={theme.dim}> · models are routed when the next task starts</Text>
        ) : null}
      </Text>
      {AGENT_ROLES.map((r) => {
        const a = AGENTS[r];
        const st = statuses[r];
        return (
          <Box key={r} flexDirection="column" marginTop={1}>
            <Text>
              <Text color={agentColor[r]} bold>{`${a.icon} ${a.label}`.padEnd(12)}</Text>
              <Text>{(assignment[r] ?? (session.mode === 'auto' ? 'auto' : '—')).padEnd(28)}</Text>
              <Text color={theme.dim}>{st?.state ?? 'idle'}{st?.note ? ` (${st.note})` : ''}</Text>
            </Text>
            <Text color={theme.dim}>{'  '}{a.description}</Text>
            <Text color={theme.dim}>{'  '}tools: {a.tools.join(', ')}</Text>
          </Box>
        );
      })}
      <Box marginTop={1}>
        <Text color={theme.dim}>
          Limits: {session.config.maxAgentSteps} tool steps per agent turn · up to {session.config.maxReviewCycles} review→fix cycles (scaled by task complexity)
        </Text>
      </Box>
    </Box>
  );
}

export function ModelsListView({ session }: { session: Session }) {
  const models = session.models;
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.border} paddingX={1} marginY={1}>
      <Text bold color={theme.brand}>Installed models</Text>
      {models.length === 0 ? <Text color={theme.warn}>No models found. Pull one with: ollama pull qwen2.5-coder:7b</Text> : null}
      {models.map((m) => {
        const emb = profileModel(m).embedding;
        return (
          <Text key={m.name} color={emb ? theme.dim : undefined}>
            {m.name.padEnd(32)} {describeModel(m).padEnd(34)} {formatBytes(m.sizeBytes).padStart(8)}
            {emb ? '  (embedding — not usable)' : ''}
          </Text>
        );
      })}
    </Box>
  );
}

export function RoutingView({ result }: { result: RoutingResult }) {
  const source =
    result.source === 'slm'
      ? `auto · routed by ${result.routerModel}`
      : result.source === 'heuristic'
        ? 'auto · heuristic fallback'
        : result.source === 'single'
          ? 'auto · single model'
          : 'manual';
  return (
    <Box flexDirection="column" marginY={0} paddingLeft={1} borderStyle="single" borderTop={false} borderRight={false} borderBottom={false} borderColor={theme.brand2}>
      <Text>
        <Text color={theme.brand2} bold>⇢ Models </Text>
        <Text color={theme.dim}>({source} · complexity {result.complexity})</Text>
      </Text>
      <Text>
        {AGENT_ROLES.map((r, i) => (
          <Text key={r}>
            {i ? <Text color={theme.dim}>  ·  </Text> : null}
            <Text color={agentColor[r]}>{AGENTS[r].label}</Text>
            <Text color={theme.dim}> </Text>
            <Text>{result.assignment[r]}</Text>
            {result.corrected.includes(r) ? <Text color={theme.warn}>*</Text> : null}
          </Text>
        ))}
      </Text>
      {result.source !== 'manual' ? <Text color={theme.dim}>{result.reasoning}</Text> : null}
      {result.corrected.length ? (
        <Text color={theme.warn}>* router suggested a model that is not installed; replaced by the best installed match</Text>
      ) : null}
    </Box>
  );
}
