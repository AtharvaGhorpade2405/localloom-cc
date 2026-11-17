/** What the model is writing into a file right now, recovered from its partial (still streaming) reply. */
export interface LiveFileProgress {
  action: 'writing' | 'editing';
  path: string;
  /** Line range being replaced, for line-based edits. */
  range?: string;
  /** The file content produced so far. */
  content: string;
  /** Number of lines produced so far. */
  lines: number;
  /** True once the block/call has been closed by the model. */
  complete: boolean;
}

const WRITE_NAMES = 'write_file|create_file|save_file';
const EDIT_NAMES = 'edit_file|replace_in_file|str_replace|modify_file';

/** Decode the (possibly unterminated) JSON string that starts at `from`. */
function decodePartialJsonString(text: string, from: number): { value: string; closed: boolean } {
  let out = '';
  for (let i = from; i < text.length; i++) {
    const c = text[i]!;
    if (c === '"') return { value: out, closed: true };
    if (c !== '\\') {
      out += c;
      continue;
    }
    const n = text[++i];
    if (n === undefined) break;
    if (n === 'n') out += '\n';
    else if (n === 't') out += '\t';
    else if (n === 'r') out += '';
    else if (n === 'u') {
      const hex = text.slice(i + 1, i + 5);
      if (hex.length < 4) break;
      out += String.fromCharCode(Number.parseInt(hex, 16) || 0xfffd);
      i += 4;
    } else out += n;
  }
  return { value: out, closed: false };
}

function countLines(content: string): number {
  if (!content) return 0;
  return content.replace(/\n$/, '').split('\n').length;
}

function finish(p: Omit<LiveFileProgress, 'lines'>): LiveFileProgress {
  const content = p.content.replace(/\r/g, '').replace(/^```[\w+.-]*\n/, '');
  return { ...p, content, lines: countLines(content) };
}

/**
 * Detect the file block or tool call the model is currently producing and return its content so far.
 * Understands the raw block format (<write_file>, <edit_file>) and JSON tool calls.
 */
export function liveFileProgress(text: string): LiveFileProgress | undefined {
  const candidates: { at: number; get: () => LiveFileProgress | undefined }[] = [];

  const lastMatch = (re: RegExp) => {
    let m: RegExpExecArray | null;
    let last: RegExpExecArray | null = null;
    while ((m = re.exec(text))) last = m;
    return last;
  };

  const write = lastMatch(/<write_file\s+path\s*=\s*["']([^"'\n]+)["']\s*>[ \t]*\r?\n?/g);
  if (write) {
    candidates.push({
      at: write.index,
      get: () => {
        const body = text.slice(write.index + write[0].length);
        const end = body.indexOf('</write_file>');
        return finish({ action: 'writing', path: write[1]!.trim(), content: end === -1 ? body : body.slice(0, end), complete: end !== -1 });
      },
    });
  }

  const edit = lastMatch(/<edit_file\s+([^>]*?)\s*>/g);
  if (edit) {
    candidates.push({
      at: edit.index,
      get: () => {
        const path = /path\s*=\s*["']([^"'\n]*)["']/.exec(edit[1]!)?.[1]?.trim();
        if (!path) return undefined;
        const range = /lines\s*=\s*["']([^"'\n]*)["']/.exec(edit[1]!)?.[1]?.trim();
        const body = text.slice(edit.index + edit[0].length);
        const open = /<new>[ \t]*\r?\n?/.exec(body);
        const after = open ? body.slice(open.index + open[0].length) : '';
        const end = after.indexOf('</new>');
        return finish({ action: 'editing', path, range, content: end === -1 ? after : after.slice(0, end), complete: body.includes('</edit_file>') });
      },
    });
  }

  const json = lastMatch(new RegExp(`"(?:name|tool|tool_name|action)"\\s*:\\s*"(${WRITE_NAMES}|${EDIT_NAMES})"`, 'g'));
  if (json) {
    candidates.push({
      at: json.index,
      get: () => {
        const rest = text.slice(json.index);
        const path = /"(?:path|file_path|filepath|filename|file)"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(rest)?.[1];
        if (!path) return undefined;
        const writing = new RegExp(`^(?:${WRITE_NAMES})$`).test(json[1]!);
        const key = writing ? /"(?:content|contents|text|code)"\s*:\s*"/.exec(rest) : /"(?:new_string|new_text|new|replacement)"\s*:\s*"/.exec(rest);
        const decoded = key ? decodePartialJsonString(rest, key.index + key[0].length) : { value: '', closed: false };
        const start = /"(?:start_line|start)"\s*:\s*"?(\d+)/.exec(rest)?.[1];
        const endLine = /"(?:end_line|end)"\s*:\s*"?(\d+)/.exec(rest)?.[1];
        return finish({
          action: writing ? 'writing' : 'editing',
          path: path.replace(/\\\\/g, '\\'),
          range: start ? (endLine && endLine !== start ? `${start}-${endLine}` : start) : undefined,
          content: decoded.value,
          complete: decoded.closed,
        });
      },
    });
  }

  for (const c of candidates.sort((a, b) => b.at - a.at)) {
    const p = c.get();
    if (p) return p;
  }
  return undefined;
}
