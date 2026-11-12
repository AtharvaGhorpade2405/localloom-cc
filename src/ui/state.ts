import { AGENTS } from '../agents/definitions.js';
import { AGENT_ROLES, type AgentRole, type LoomEvent, type NoticeLevel } from '../agents/events.js';
import { stripTrailingJsonBlock } from '../agents/toolParse.js';
import type { RoutingResult } from '../router/router.js';

export type ChatItem =
  | { id: number; kind: 'banner' }
  | { id: number; kind: 'user'; text: string }
  | { id: number; kind: 'agent'; agent: AgentRole; model: string; text: string }
  | { id: number; kind: 'tool'; agent: AgentRole; name: string; detail: string; ok: boolean; summary: string }
  | { id: number; kind: 'notice'; level: NoticeLevel; text: string }
  | { id: number; kind: 'routing'; result: RoutingResult }
  | { id: number; kind: 'phase'; text: string }
  | { id: number; kind: 'taskEnd'; status: 'done' | 'cancelled' | 'error'; summary: string; files: string[]; elapsedMs: number }
  | { id: number; kind: 'help' }
  | { id: number; kind: 'agents' }
  | { id: number; kind: 'models' };

export type AgentState = 'idle' | 'waiting' | 'working' | 'done' | 'error' | 'skipped';

export interface AgentStatus {
  state: AgentState;
  model?: string;
  note?: string;
  step?: number;
  maxSteps?: number;
  label?: string;
}

export interface RunningTool {
  id: string;
  agent: AgentRole;
  name: string;
  detail: string;
}

export interface UIState {
  items: ChatItem[];
  busy: boolean;
  routing: boolean;
  taskStart?: number;
  activeAgent?: AgentRole;
  activeModel?: string;
  liveText: string;
  liveThinking: string;
  runningTools: RunningTool[];
  agents: Record<AgentRole, AgentStatus>;
  phase?: string;
}

let nextId = 1;
export const newId = () => nextId++;

/** Distributive Omit so each ChatItem variant keeps its own fields. */
export type NewChatItem = ChatItem extends infer T ? (T extends ChatItem ? Omit<T, 'id'> : never) : never;

function idleAgents(): Record<AgentRole, AgentStatus> {
  return Object.fromEntries(AGENT_ROLES.map((r) => [r, { state: 'idle' as AgentState }])) as Record<AgentRole, AgentStatus>;
}

export function initialState(): UIState {
  return {
    items: [{ id: newId(), kind: 'banner' }],
    busy: false,
    routing: false,
    liveText: '',
    liveThinking: '',
    runningTools: [],
    agents: idleAgents(),
  };
}

export type Action =
  | { type: 'event'; event: LoomEvent }
  | { type: 'push'; item: NewChatItem }
  | { type: 'live'; text: string; thinking: string }
  | { type: 'busy'; busy: boolean }
  | { type: 'clear' };

/** Prose shown for a completed agent message (machine-readable JSON blocks removed). */
export function displayText(agent: AgentRole, text: string): string {
  if (agent === 'planner') return stripTrailingJsonBlock(text, 'needs_changes');
  if (agent === 'reviewer') return stripTrailingJsonBlock(text, 'verdict');
  return text.trim();
}

export function reducer(state: UIState, action: Action): UIState {
  switch (action.type) {
    case 'push':
      return { ...state, items: [...state.items, { ...action.item, id: newId() } as ChatItem] };
    case 'live':
      return { ...state, liveText: action.text, liveThinking: action.thinking };
    case 'busy':
      return { ...state, busy: action.busy };
    case 'clear':
      return { ...initialState(), items: [{ id: newId(), kind: 'banner' }], agents: state.busy ? state.agents : idleAgents() };
    case 'event':
      return applyEvent(state, action.event);
    default:
      return state;
  }
}

function setAgent(state: UIState, role: AgentRole, patch: Partial<AgentStatus>): Record<AgentRole, AgentStatus> {
  return { ...state.agents, [role]: { ...state.agents[role], ...patch } };
}

function applyEvent(state: UIState, e: LoomEvent): UIState {
  const push = (item: NewChatItem): ChatItem[] => [...state.items, { ...item, id: newId() } as ChatItem];
  switch (e.type) {
    case 'task:start': {
      const agents = Object.fromEntries(
        AGENT_ROLES.map((r) => [r, { state: 'waiting' as AgentState, model: state.agents[r].model }]),
      ) as Record<AgentRole, AgentStatus>;
      return { ...state, busy: true, taskStart: Date.now(), agents, phase: undefined, liveText: '', liveThinking: '', runningTools: [] };
    }
    case 'routing:start':
      return { ...state, routing: true };
    case 'routing': {
      const agents = { ...state.agents };
      for (const r of AGENT_ROLES) agents[r] = { ...agents[r], model: e.result.assignment[r] };
      return { ...state, routing: false, agents, items: push({ kind: 'routing', result: e.result }) };
    }
    case 'agent:start':
      return {
        ...state,
        activeAgent: e.agent,
        activeModel: e.model,
        liveText: '',
        liveThinking: '',
        agents: setAgent(state, e.agent, { state: 'working', model: e.model, label: e.label, note: undefined, step: 0 }),
      };
    case 'agent:step':
      return { ...state, agents: setAgent(state, e.agent, { step: e.step, maxSteps: e.maxSteps }) };
    case 'agent:message': {
      const text = displayText(e.agent, e.content);
      return {
        ...state,
        liveText: '',
        liveThinking: '',
        items: text ? push({ kind: 'agent', agent: e.agent, model: e.model, text }) : state.items,
      };
    }
    case 'tool:start':
      return {
        ...state,
        liveText: '',
        runningTools: [...state.runningTools, { id: e.id, agent: e.agent, name: e.name, detail: e.detail }],
      };
    case 'tool:end':
      return {
        ...state,
        runningTools: state.runningTools.filter((t) => t.id !== e.id),
        items: push({ kind: 'tool', agent: e.agent, name: e.name, detail: e.detail, ok: e.ok, summary: e.summary }),
      };
    case 'agent:end':
      return {
        ...state,
        activeAgent: state.activeAgent === e.agent ? undefined : state.activeAgent,
        agents: setAgent(state, e.agent, { state: e.status, note: e.note }),
      };
    case 'phase':
      return { ...state, phase: e.text, items: push({ kind: 'phase', text: e.text }) };
    case 'notice':
      return { ...state, items: push({ kind: 'notice', level: e.level, text: e.text }) };
    case 'task:end': {
      const agents = { ...state.agents };
      for (const r of AGENT_ROLES) {
        if (agents[r].state === 'waiting' || agents[r].state === 'working') {
          agents[r] = { ...agents[r], state: e.status === 'done' ? 'skipped' : 'idle' };
        }
      }
      return {
        ...state,
        busy: false,
        routing: false,
        activeAgent: undefined,
        liveText: '',
        liveThinking: '',
        runningTools: [],
        agents,
        phase: undefined,
        items: push({
          kind: 'taskEnd',
          status: e.status,
          summary: e.summary,
          files: e.changedFiles,
          elapsedMs: state.taskStart ? Date.now() - state.taskStart : 0,
        }),
      };
    }
    default:
      return state;
  }
}

export function agentLabel(role: AgentRole): string {
  return AGENTS[role].label;
}
