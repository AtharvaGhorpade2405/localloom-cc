import type { RoutingResult } from '../router/router.js';

export type AgentRole = 'planner' | 'coder' | 'reviewer' | 'fixer';
export const AGENT_ROLES: AgentRole[] = ['planner', 'coder', 'reviewer', 'fixer'];

export type NoticeLevel = 'info' | 'success' | 'warn' | 'error';

export type LoomEvent =
  | { type: 'task:start'; task: string }
  | { type: 'routing:start'; routerModel?: string }
  | { type: 'routing'; result: RoutingResult }
  | { type: 'agent:start'; agent: AgentRole; model: string; label?: string }
  | { type: 'agent:content'; agent: AgentRole; delta: string }
  | { type: 'agent:thinking'; agent: AgentRole; delta: string }
  /** A completed assistant message (prose only; tool-call payloads removed). */
  | { type: 'agent:message'; agent: AgentRole; model: string; content: string }
  | { type: 'agent:step'; agent: AgentRole; step: number; maxSteps: number }
  | { type: 'tool:start'; agent: AgentRole; id: string; name: string; detail: string }
  | { type: 'tool:end'; agent: AgentRole; id: string; name: string; detail: string; ok: boolean; summary: string }
  | { type: 'agent:end'; agent: AgentRole; status: 'done' | 'error' | 'skipped'; note?: string }
  | { type: 'phase'; text: string }
  | { type: 'notice'; level: NoticeLevel; text: string }
  | { type: 'task:end'; status: 'done' | 'cancelled' | 'error'; summary: string; changedFiles: string[] };

export type EmitFn = (event: LoomEvent) => void;
