import { Box, Text, useInput } from 'ink';
import { useState } from 'react';
import { AGENTS } from '../../agents/definitions.js';
import { AGENT_ROLES, type AgentRole } from '../../agents/events.js';
import { describeModel, formatBytes } from '../../ollama/modelProfile.js';
import type { ModelInfo } from '../../ollama/types.js';
import { agentColor, theme } from '../theme.js';

type Target = AgentRole | 'all';
const TARGETS: Target[] = ['all', ...AGENT_ROLES];

interface Props {
  models: ModelInfo[];
  assignment: Partial<Record<AgentRole, string>>;
  mode: 'auto' | 'manual';
  error?: string;
  onSelect: (model: string, target: Target) => void;
  onAuto: () => void;
  onRefresh: () => void;
  onClose: () => void;
}

export function ModelPicker({ models, assignment, mode, error, onSelect, onAuto, onRefresh, onClose }: Props) {
  // Row 0 is "Auto mode", then one row per model.
  const initial = Math.max(0, models.findIndex((m) => m.name === assignment.coder) + 1);
  const [idx, setIdx] = useState(mode === 'auto' ? 0 : initial);
  const [target, setTarget] = useState<Target>('all');
  const rows = models.length + 1;
  const WINDOW = 10;

  useInput((input, key) => {
    if (key.escape || input === 'q') return onClose();
    if (key.upArrow || input === 'k') return setIdx((i) => (i - 1 + rows) % rows);
    if (key.downArrow || input === 'j') return setIdx((i) => (i + 1) % rows);
    if (key.tab || key.rightArrow) return setTarget((t) => TARGETS[(TARGETS.indexOf(t) + 1) % TARGETS.length]!);
    if (key.leftArrow) return setTarget((t) => TARGETS[(TARGETS.indexOf(t) - 1 + TARGETS.length) % TARGETS.length]!);
    if (input === 'r') return onRefresh();
    if (key.return) {
      if (idx === 0) return onAuto();
      const m = models[idx - 1];
      if (m) onSelect(m.name, target);
    }
  });

  const start = Math.max(0, Math.min(idx - 1 - Math.floor(WINDOW / 2), models.length - WINDOW));
  const visible = models.slice(start, start + WINDOW);

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.borderActive} paddingX={1}>
      <Text>
        <Text bold color={theme.brand}>Select model</Text>
        <Text color={theme.dim}>  current mode: </Text>
        <Text bold>{mode.toUpperCase()}</Text>
      </Text>
      <Text>
        <Text color={theme.dim}>Assign to: </Text>
        {TARGETS.map((t) => (
          <Text key={t}>
            <Text
              color={t === target ? 'black' : t === 'all' ? theme.text : agentColor[t]}
              backgroundColor={t === target ? theme.accent : undefined}
            >
              {` ${t === 'all' ? 'All agents' : AGENTS[t].label} `}
            </Text>
            <Text> </Text>
          </Text>
        ))}
      </Text>
      {error ? <Text color={theme.error}>{error}</Text> : null}
      <Box marginTop={1} flexDirection="column">
        <Text color={idx === 0 ? theme.accent : theme.text} bold={idx === 0}>
          {idx === 0 ? '▸ ' : '  '}⚡ Auto mode <Text color={theme.dim}>— a local SLM picks the best model for each agent</Text>
        </Text>
        {start > 0 ? <Text color={theme.dim}>  ↑ {start} more</Text> : null}
        {visible.map((m, i) => {
          const row = start + i + 1;
          const selected = row === idx;
          const users = AGENT_ROLES.filter((r) => assignment[r] === m.name);
          return (
            <Text key={m.name}>
              <Text color={selected ? theme.accent : theme.text} bold={selected}>
                {selected ? '▸ ' : '  '}
                {m.name.padEnd(30)}
              </Text>
              <Text color={theme.dim}>{describeModel(m).padEnd(32)}</Text>
              <Text color={theme.dim}>{formatBytes(m.sizeBytes).padStart(8)}  ctx {String(m.contextLength).padEnd(7)}</Text>
              {mode === 'manual' && users.length ? (
                <Text>
                  {users.map((u) => (
                    <Text key={u} color={agentColor[u]}>{AGENTS[u].icon}</Text>
                  ))}
                </Text>
              ) : null}
            </Text>
          );
        })}
        {start + WINDOW < models.length ? <Text color={theme.dim}>  ↓ {models.length - start - WINDOW} more</Text> : null}
        {models.length === 0 ? (
          <Text color={theme.warn}>  No chat models installed. Run: ollama pull qwen2.5-coder:7b — then press r</Text>
        ) : null}
      </Box>
      <Box marginTop={1}>
        <Text color={theme.dim}>↑↓ select · tab/←→ choose agent · enter apply · r refresh · esc close</Text>
      </Box>
    </Box>
  );
}
