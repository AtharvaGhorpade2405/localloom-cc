import { Box, Text } from 'ink';
import React from 'react';
import { theme } from '../theme.js';

/** Render inline markdown: `code`, **bold**, *italic*. */
export function Inline({ text, color }: { text: string; color?: string }) {
  const parts: React.ReactNode[] = [];
  const re = /(`[^`]+`|\*\*[^*]+\*\*|__[^_]+__|\*[^*\s][^*]*\*)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let k = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) parts.push(text.slice(last, m.index));
    const tok = m[0];
    if (tok.startsWith('`')) parts.push(<Text key={k++} color={theme.code}>{tok.slice(1, -1)}</Text>);
    else if (tok.startsWith('**') || tok.startsWith('__')) parts.push(<Text key={k++} bold>{tok.slice(2, -2)}</Text>);
    else parts.push(<Text key={k++} italic>{tok.slice(1, -1)}</Text>);
    last = m.index + tok.length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return <Text color={color}>{parts}</Text>;
}

interface Block {
  type: 'code' | 'text';
  lang?: string;
  lines: string[];
}

function toBlocks(src: string): Block[] {
  const blocks: Block[] = [];
  let cur: Block | null = null;
  for (const line of src.replace(/\r\n/g, '\n').split('\n')) {
    const fence = /^\s*```\s*([\w+-]*)\s*$/.exec(line);
    if (fence) {
      if (cur?.type === 'code') {
        blocks.push(cur);
        cur = null;
      } else {
        if (cur) blocks.push(cur);
        cur = { type: 'code', lang: fence[1] || undefined, lines: [] };
      }
      continue;
    }
    if (!cur) cur = { type: 'text', lines: [] };
    cur.lines.push(line);
  }
  if (cur) blocks.push(cur);
  return blocks;
}

export function Markdown({ text, maxCodeLines = 40 }: { text: string; maxCodeLines?: number }) {
  const blocks = toBlocks(text);
  return (
    <Box flexDirection="column">
      {blocks.map((b, i) => {
        if (b.type === 'code') {
          const shown = b.lines.slice(0, maxCodeLines);
          return (
            <Box key={i} flexDirection="column" borderStyle="single" borderTop={false} borderRight={false} borderBottom={false} borderColor={theme.border} paddingLeft={1} marginY={0}>
              {b.lang ? <Text color={theme.dim}>{b.lang}</Text> : null}
              {shown.map((l, j) => (
                <Text key={j} color={theme.codeBlock}>
                  {l || ' '}
                </Text>
              ))}
              {b.lines.length > shown.length ? (
                <Text color={theme.dim}>… {b.lines.length - shown.length} more lines</Text>
              ) : null}
            </Box>
          );
        }
        // Collapse runs of blank lines.
        const lines = b.lines.filter((l, j, arr) => !(l.trim() === '' && (arr[j - 1] ?? '').trim() === ''));
        while (lines.length && !lines[0]!.trim()) lines.shift();
        while (lines.length && !lines[lines.length - 1]!.trim()) lines.pop();
        return (
          <Box key={i} flexDirection="column">
            {lines.map((l, j) => {
              const h = /^(#{1,6})\s+(.*)$/.exec(l);
              if (h) return <Text key={j} bold color={theme.heading}>{h[2]}</Text>;
              const bullet = /^(\s*)[-*+]\s+(.*)$/.exec(l);
              if (bullet)
                return (
                  <Text key={j}>
                    {bullet[1]}
                    <Text color={theme.accent}>• </Text>
                    <Inline text={bullet[2]!} />
                  </Text>
                );
              const num = /^(\s*)(\d+)[.)]\s+(.*)$/.exec(l);
              if (num)
                return (
                  <Text key={j}>
                    {num[1]}
                    <Text color={theme.accent}>{num[2]}. </Text>
                    <Inline text={num[3]!} />
                  </Text>
                );
              return <Inline key={j} text={l || ' '} />;
            })}
          </Box>
        );
      })}
    </Box>
  );
}
