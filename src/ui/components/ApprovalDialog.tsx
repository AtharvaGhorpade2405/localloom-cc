import { Box, Text, useInput } from 'ink';
import { useState } from 'react';
import type { ApprovalDecision, ApprovalRequest } from '../../tools/registry.js';
import { theme } from '../theme.js';

const OPTIONS: { key: string; label: string; value: ApprovalDecision }[] = [
  { key: 'y', label: 'Yes, once', value: 'yes' },
  { key: 'a', label: 'Always allow this in this session', value: 'always' },
  { key: 'n', label: 'No, deny', value: 'no' },
];

export function ApprovalDialog({ request, onDecide }: { request: ApprovalRequest; onDecide: (d: ApprovalDecision) => void }) {
  const [idx, setIdx] = useState(0);
  useInput((input, key) => {
    const lower = input.toLowerCase();
    const byKey = OPTIONS.find((o) => o.key === lower);
    if (byKey) return onDecide(byKey.value);
    if (key.escape) return onDecide('no');
    if (key.upArrow) return setIdx((i) => (i - 1 + OPTIONS.length) % OPTIONS.length);
    if (key.downArrow || key.tab) return setIdx((i) => (i + 1) % OPTIONS.length);
    if (key.return) onDecide(OPTIONS[idx]!.value);
  });
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.warn} paddingX={1}>
      <Text bold color={theme.warn}>
        ▲ {request.title}
      </Text>
      <Box marginY={1} paddingX={1}>
        <Text color={request.kind === 'command' ? theme.text : theme.error} bold>
          {request.kind === 'command' ? `$ ${request.detail}` : request.detail}
        </Text>
      </Box>
      <Text color={theme.dim}>{request.reason}</Text>
      <Box flexDirection="column" marginTop={1}>
        {OPTIONS.map((o, i) => (
          <Text key={o.key} color={i === idx ? theme.accent : theme.text} bold={i === idx}>
            {i === idx ? '▸ ' : '  '}[{o.key}] {o.label}
          </Text>
        ))}
      </Box>
    </Box>
  );
}
