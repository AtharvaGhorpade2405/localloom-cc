import { Box, Text, useInput } from 'ink';
import { useReducer, useRef } from 'react';
import { matchCommands } from '../commands.js';
import { theme } from '../theme.js';

interface Props {
  isActive: boolean;
  busy: boolean;
  width: number;
  onSubmit: (value: string) => void;
  onEmptyTab?: () => void;
}

/** Single-line prompt with cursor movement, history, and slash-command completion. */
export function PromptInput({ isActive, busy, width, onSubmit, onEmptyTab }: Props) {
  // State lives in a ref so that rapid keystrokes (typing fast, pasting) arriving between
  // renders always see the latest value instead of a stale closure.
  const st = useRef({ value: '', cursor: 0, history: [] as string[], histIdx: -1, sel: 0 });
  const [, force] = useReducer((x: number) => x + 1, 0);

  const suggestionsFor = (v: string) => {
    const list = matchCommands(v);
    return { list, show: list.length > 0 && !(list.length === 1 && list[0]!.name === v) };
  };

  const update = (v: string, c = v.length) => {
    st.current.value = v;
    st.current.cursor = Math.max(0, Math.min(v.length, c));
    st.current.sel = 0;
    force();
  };

  useInput(
    (input, key) => {
      const s = st.current;
      const { list: suggestions, show: showSuggestions } = suggestionsFor(s.value);
      if (key.return) {
        let v = s.value;
        // Enter on a partially typed command picks the highlighted suggestion.
        if (showSuggestions && suggestions[s.sel]) v = suggestions[s.sel]!.name;
        if (!v.trim()) return;
        if (s.history[s.history.length - 1] !== v) s.history = [...s.history, v].slice(-100);
        s.histIdx = -1;
        update('');
        onSubmit(v.trim());
        return;
      }
      if (key.tab) {
        if (showSuggestions && suggestions[s.sel]) update(`${suggestions[s.sel]!.name} `);
        else if (!s.value) onEmptyTab?.();
        return;
      }
      if (key.upArrow) {
        if (showSuggestions) {
          s.sel = (s.sel - 1 + suggestions.length) % suggestions.length;
          force();
          return;
        }
        if (!s.history.length) return;
        s.histIdx = s.histIdx === -1 ? s.history.length - 1 : Math.max(0, s.histIdx - 1);
        const v = s.history[s.histIdx]!;
        s.value = v;
        s.cursor = v.length;
        force();
        return;
      }
      if (key.downArrow) {
        if (showSuggestions) {
          s.sel = (s.sel + 1) % suggestions.length;
          force();
          return;
        }
        if (s.histIdx === -1) return;
        const idx = s.histIdx + 1;
        if (idx >= s.history.length) {
          s.histIdx = -1;
          update('');
        } else {
          s.histIdx = idx;
          s.value = s.history[idx]!;
          s.cursor = s.value.length;
          force();
        }
        return;
      }
      if (key.leftArrow) {
        s.cursor = Math.max(0, s.cursor - 1);
        return force();
      }
      if (key.rightArrow) {
        s.cursor = Math.min(s.value.length, s.cursor + 1);
        return force();
      }
      if (key.backspace || key.delete) {
        if (s.cursor === 0) return;
        update(s.value.slice(0, s.cursor - 1) + s.value.slice(s.cursor), s.cursor - 1);
        return;
      }
      if (key.ctrl) {
        if (input === 'a') {
          s.cursor = 0;
          return force();
        }
        if (input === 'e') {
          s.cursor = s.value.length;
          return force();
        }
        if (input === 'u') return update('');
        if (input === 'w') {
          const before = s.value.slice(0, s.cursor).replace(/\S+\s*$/, '');
          update(before + s.value.slice(s.cursor), before.length);
        }
        return;
      }
      if (key.meta || key.escape) return;
      if (input) {
        const clean = input.replace(/\r?\n/g, ' ').replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '');
        if (!clean) return;
        update(s.value.slice(0, s.cursor) + clean + s.value.slice(s.cursor), s.cursor + clean.length);
      }
    },
    { isActive },
  );

  const { value, cursor, sel } = st.current;
  const { list: suggestions, show: showSuggestions } = suggestionsFor(value);
  const placeholder = busy ? 'Agents are working… (esc to cancel, /agents for status)' : 'Describe a coding task, ask a question, or type / for commands';
  const before = value.slice(0, cursor);
  const at = value[cursor] ?? ' ';
  const after = value.slice(cursor + 1);

  return (
    <Box flexDirection="column" width={width}>
      <Box borderStyle="round" borderColor={isActive ? theme.borderActive : theme.border} paddingX={1}>
        <Text color={theme.accent} bold>
          {'› '}
        </Text>
        {value ? (
          <Text>
            {before}
            {isActive ? <Text inverse>{at}</Text> : at}
            {after}
          </Text>
        ) : (
          <Text>
            {isActive ? <Text inverse> </Text> : null}
            <Text color={theme.dim}>{placeholder}</Text>
          </Text>
        )}
      </Box>
      {showSuggestions && isActive ? (
        <Box flexDirection="column" paddingX={2}>
          {suggestions.map((s, i) => (
            <Text key={s.name}>
              <Text color={i === sel ? theme.accent : theme.text} bold={i === sel}>
                {i === sel ? '▸ ' : '  '}
                {`${s.name}${s.args ? ` ${s.args}` : ''}`.padEnd(20)}
              </Text>
              <Text color={theme.dim}>{s.description}</Text>
            </Text>
          ))}
        </Box>
      ) : null}
    </Box>
  );
}
