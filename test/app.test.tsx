import { render } from 'ink-testing-library';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { Session } from '../src/core/session.js';
import { App } from '../src/ui/App.js';
import { matchCommands, parseCommand } from '../src/ui/commands.js';
import { FakeClient, model, roleOf, tmpDir } from './helpers.js';

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn: () => boolean, timeout = 3000) {
  const start = Date.now();
  while (!fn()) {
    if (Date.now() - start > timeout) throw new Error('timeout');
    await wait(20);
  }
}

function makeSession() {
  const client = new FakeClient([model('qwen2.5-coder:7b'), model('llama3.2:3b', { paramsB: 3.2 })], (req) => {
    if (roleOf(req) === 'planner') return { content: 'Hello! I can help.\n{"needs_changes": false, "summary": "greeting"}' };
    return { content: '{"complexity":"low","planner":"llama3.2:3b","coder":"qwen2.5-coder:7b","reviewer":"llama3.2:3b","fixer":"qwen2.5-coder:7b","reasoning":"small task"}' };
  });
  return new Session({ client, config: loadConfig(), cwd: tmpDir() });
}

describe('commands', () => {
  it('matches and parses', () => {
    expect(matchCommands('/mo').map((c) => c.name)).toEqual(['/models']);
    expect(parseCommand('/models qwen2.5-coder:7b')).toEqual({ name: '/models', args: 'qwen2.5-coder:7b' });
    expect(parseCommand('/quit')?.name).toBe('/exit');
  });
});

describe('App', () => {
  it('renders the banner, status bar and model announcement', async () => {
    const session = makeSession();
    const { lastFrame, frames, unmount } = render(<App session={session} />);
    await waitFor(() => frames.join('\n').includes('Auto mode'));
    const out = frames.join('\n');
    expect(out).toContain('AUTO');
    expect(out).toContain('Planner');
    expect(out).toContain('Fixer');
    expect(lastFrame()).toContain('ollama');
    unmount();
  });

  it('handles /help, /manual and a full task', async () => {
    const session = makeSession();
    const { stdin, frames, unmount } = render(<App session={session} />);
    await waitFor(() => frames.join('\n').includes('Auto mode'));
    stdin.write('/help');
    await wait(30);
    stdin.write('\r');
    await waitFor(() => frames.join('\n').includes('Keys'));
    stdin.write('/manual');
    await wait(30);
    stdin.write('\r');
    await waitFor(() => frames.join('\n').includes('Manual mode enabled'));
    expect(session.mode).toBe('manual');
    stdin.write('/auto');
    await wait(30);
    stdin.write('\r');
    await waitFor(() => session.mode === 'auto');
    stdin.write('hello there');
    await wait(30);
    stdin.write('\r');
    await waitFor(() => frames.join('\n').includes('Hello! I can help.'));
    await waitFor(() => frames.join('\n').includes('Done'));
    const out = frames.join('\n');
    expect(out).toContain('routed by llama3.2:3b');
    unmount();
  });
});
