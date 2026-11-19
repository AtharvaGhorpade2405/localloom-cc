export interface CommandInfo {
  name: string;
  args?: string;
  description: string;
  aliases?: string[];
}

export const COMMANDS: CommandInfo[] = [
  { name: '/models', args: '[model]', description: 'View and select installed Ollama models' },
  { name: '/auto', description: 'Enable Auto mode — a local SLM routes models to agents' },
  { name: '/groq', args: '[model]', description: 'Toggle running the Coder and Fixer on Groq (Auto mode), or pick the Groq model' },
  { name: '/manual', args: '[model]', description: 'Enable Manual mode — you choose the model' },
  { name: '/undo', args: '[force]', description: 'Revert the file changes made by the last request (repeat to go further back)' },
  { name: '/new', description: 'Start a new project folder with your next request' },
  { name: '/session', args: '[n|id]', description: 'Browse saved chats and resume one (stored locally)', aliases: ['/sessions', '/history', '/resume'] },
  { name: '/agents', description: 'Show agent roles, assigned models and status' },
  { name: '/approve', description: 'Toggle auto-approval of commands' },
  { name: '/clear', description: 'Clear the screen and in-memory conversation context' },
  { name: '/help', description: 'Show commands and keyboard shortcuts' },
  { name: '/exit', description: 'Exit LocalLoom', aliases: ['/quit', '/q'] },
];

export function matchCommands(input: string): CommandInfo[] {
  if (!input.startsWith('/') || input.includes(' ')) return [];
  const q = input.toLowerCase();
  return COMMANDS.filter((c) => c.name.startsWith(q) || c.aliases?.some((a) => a.startsWith(q)));
}

export function parseCommand(input: string): { name: string; args: string } | undefined {
  const m = /^\/(\S+)\s*(.*)$/s.exec(input.trim());
  if (!m) return undefined;
  const raw = `/${m[1]!.toLowerCase()}`;
  const cmd = COMMANDS.find((c) => c.name === raw || c.aliases?.includes(raw));
  return { name: cmd?.name ?? raw, args: m[2]!.trim() };
}
