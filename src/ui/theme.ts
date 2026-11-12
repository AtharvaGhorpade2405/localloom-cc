import type { AgentRole } from '../agents/events.js';

export const theme = {
  brand: '#a78bfa',
  brand2: '#38bdf8',
  accent: '#a78bfa',
  text: 'white',
  dim: 'gray',
  border: '#4b5563',
  borderActive: '#a78bfa',
  code: '#f0abfc',
  codeBlock: '#cbd5e1',
  heading: '#e9d5ff',
  success: '#4ade80',
  warn: '#facc15',
  error: '#f87171',
  info: '#38bdf8',
  user: '#38bdf8',
};

export const agentColor: Record<AgentRole, string> = {
  planner: '#c084fc',
  coder: '#22d3ee',
  reviewer: '#fbbf24',
  fixer: '#4ade80',
};

export const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
