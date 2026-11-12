import { Box, Text } from 'ink';
import { AGENTS } from '../../agents/definitions.js';
import type { Session } from '../../core/session.js';
import type { AgentStatus, ChatItem } from '../state.js';
import { agentColor, theme } from '../theme.js';
import { Markdown } from './Markdown.js';
import { AgentsView, Banner, HelpView, ModelsListView, RoutingView } from './Views.js';

function formatElapsed(ms: number): string {
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

const NOTICE_ICON = { info: 'ℹ', success: '✓', warn: '▲', error: '✗' } as const;
const NOTICE_COLOR = { info: theme.info, success: theme.success, warn: theme.warn, error: theme.error } as const;

export function MessageItem({
  item,
  session,
  statuses,
}: {
  item: ChatItem;
  session: Session;
  statuses: Record<string, AgentStatus>;
}) {
  switch (item.kind) {
    case 'banner':
      return <Banner cwd={session.workspace.root} />;
    case 'user':
      return (
        <Box marginTop={1} paddingLeft={1} borderStyle="bold" borderTop={false} borderRight={false} borderBottom={false} borderColor={theme.user}>
          <Text bold>{item.text}</Text>
        </Box>
      );
    case 'agent': {
      const a = AGENTS[item.agent];
      return (
        <Box flexDirection="column" marginTop={1}>
          <Text>
            <Text color={agentColor[item.agent]} bold>{a.icon} {a.label}</Text>
            <Text color={theme.dim}> · {item.model}</Text>
          </Text>
          <Box paddingLeft={2}>
            <Markdown text={item.text} />
          </Box>
        </Box>
      );
    }
    case 'tool':
      return (
        <Text>
          {'  '}
          <Text color={item.ok ? theme.success : theme.error}>{item.ok ? '✓' : '✗'}</Text>
          <Text color={agentColor[item.agent]}> {item.name}</Text>
          <Text> {item.detail}</Text>
          <Text color={theme.dim}>  {item.summary}</Text>
        </Text>
      );
    case 'notice':
      return (
        <Box marginTop={item.level === 'error' ? 1 : 0}>
          <Text color={NOTICE_COLOR[item.level]}>
            {NOTICE_ICON[item.level]} {item.text}
          </Text>
        </Box>
      );
    case 'routing':
      return (
        <Box marginTop={1}>
          <RoutingView result={item.result} />
        </Box>
      );
    case 'phase':
      return (
        <Box marginTop={1}>
          <Text color={theme.dim}>── {item.text} ──</Text>
        </Box>
      );
    case 'taskEnd': {
      const color = item.status === 'done' ? theme.success : item.status === 'cancelled' ? theme.warn : theme.error;
      const icon = item.status === 'done' ? '✔' : item.status === 'cancelled' ? '■' : '✗';
      return (
        <Box flexDirection="column" marginTop={1}>
          <Text>
            <Text color={color} bold>{icon} {item.status === 'done' ? 'Done' : item.status === 'cancelled' ? 'Cancelled' : 'Failed'}</Text>
            <Text color={theme.dim}> in {formatElapsed(item.elapsedMs)} · </Text>
            <Text>{item.summary}</Text>
          </Text>
          {item.files.length ? (
            <Text color={theme.dim}>
              {'  '}files: <Text color={theme.text}>{item.files.join(', ')}</Text>
            </Text>
          ) : null}
        </Box>
      );
    }
    case 'help':
      return <HelpView />;
    case 'agents':
      return <AgentsView session={session} statuses={statuses} />;
    case 'models':
      return <ModelsListView session={session} />;
  }
}
