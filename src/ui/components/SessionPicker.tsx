import { Box, Text, useInput } from 'ink';
import { useState } from 'react';
import type { SessionSummary } from '../../core/history.js';
import { theme } from '../theme.js';

interface Props {
  sessions: SessionSummary[];
  currentId?: string;
  dir: string;
  onOpen: (id: string) => void;
  onDelete: (id: string) => void;
  onClose: () => void;
}

export function formatWhen(iso: string, now = new Date()): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '?';
  const pad = (n: number) => String(n).padStart(2, '0');
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  if (d.toDateString() === now.toDateString()) return `today ${time}`;
  const y = new Date(now);
  y.setDate(now.getDate() - 1);
  if (d.toDateString() === y.toDateString()) return `yesterday ${time}`;
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${time}`;
}

export function SessionPicker({ sessions, currentId, dir, onOpen, onDelete, onClose }: Props) {
  const [idx, setIdx] = useState(0);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const rows = sessions.length;
  const WINDOW = 10;

  useInput((input, key) => {
    if (key.escape || input === 'q') return confirmDelete ? setConfirmDelete(false) : onClose();
    if (!rows) return;
    if (input === 'd' || key.delete) {
      const s = sessions[idx];
      if (!s) return;
      if (!confirmDelete) return setConfirmDelete(true);
      setConfirmDelete(false);
      setIdx((i) => Math.max(0, Math.min(i, rows - 2)));
      return onDelete(s.id);
    }
    setConfirmDelete(false);
    if (key.upArrow || input === 'k') return setIdx((i) => (i - 1 + rows) % rows);
    if (key.downArrow || input === 'j') return setIdx((i) => (i + 1) % rows);
    if (key.return) {
      const s = sessions[idx];
      if (s) onOpen(s.id);
    }
  });

  const start = Math.max(0, Math.min(idx - Math.floor(WINDOW / 2), rows - WINDOW));
  const visible = sessions.slice(start, start + WINDOW);
  const selected = sessions[idx];

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.borderActive} paddingX={1}>
      <Text>
        <Text bold color={theme.brand}>Chat history</Text>
        <Text color={theme.dim}>  {rows} saved · stored locally in {dir}</Text>
      </Text>
      <Box marginTop={1} flexDirection="column">
        {rows === 0 ? <Text color={theme.dim}>  No saved chats yet. Chats are saved automatically once you send a message.</Text> : null}
        {start > 0 ? <Text color={theme.dim}>  ↑ {start} more</Text> : null}
        {visible.map((s, i) => {
          const row = start + i;
          const sel = row === idx;
          return (
            <Text key={s.id} wrap="truncate-end">
              <Text color={sel ? theme.accent : theme.dim} bold={sel}>
                {sel ? '▸ ' : '  '}
                {String(row + 1).padStart(2)}.{' '}
              </Text>
              <Text color={theme.dim}>{formatWhen(s.updatedAt).padEnd(17)}</Text>
              <Text color={sel ? theme.accent : theme.text} bold={sel}>{s.title}</Text>
              <Text color={theme.dim}>
                {'  '}
                {s.messages} msg{s.messages === 1 ? '' : 's'}
                {s.projectName ? ` · ${s.projectName}` : ''}
                {s.id === currentId ? ' · current' : ''}
              </Text>
            </Text>
          );
        })}
        {start + WINDOW < rows ? <Text color={theme.dim}>  ↓ {rows - start - WINDOW} more</Text> : null}
      </Box>
      {confirmDelete && selected ? (
        <Box marginTop={1}>
          <Text color={theme.warn}>Delete “{selected.title}” permanently? Press d again to confirm, any other key to keep it.</Text>
        </Box>
      ) : null}
      <Box marginTop={1}>
        <Text color={theme.dim}>↑↓ select · enter open · d delete · esc close</Text>
      </Box>
    </Box>
  );
}
