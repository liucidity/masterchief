import type { AgentRole } from '@masterchief/core';

export interface Permissions {
  /** Normalized tool names the agent may call. */
  tools: string[];
}

export interface ToolCallRequest {
  tool: string;
  args: Record<string, unknown>;
}

export type GateDecision = { allow: true } | { allow: false; reason: string };

/** Asked before every tool call; the daemon alone answers. */
export type ToolGate = (call: ToolCallRequest) => GateDecision;

export interface Usage {
  inputTokens: number;
  outputTokens: number;
}

/** Normalized stream every adapter emits, whatever the provider. */
export type AgentEvent =
  | { kind: 'text'; text: string }
  | { kind: 'tool_call'; id: string; tool: string; args: Record<string, unknown> }
  | { kind: 'tool_result'; id: string; ok: boolean; output: string }
  | { kind: 'error'; message: string }
  | { kind: 'done'; usage: Usage };

export interface SessionSpec {
  role: AgentRole;
  /** Standing instructions for the whole session. */
  instructions: string;
  context: string;
  /** The agent's worktree. */
  cwd: string;
  permissions: Permissions;
  model: string;
  /** Adapters must call this before running any tool. */
  gate: ToolGate;
}

export interface AgentSession {
  /** Message a running session; yields events until the turn ends with `done` or `error`. */
  send(message: string): AsyncIterable<AgentEvent>;
  close(): Promise<void>;
}

export interface ProviderCapabilities {
  tools: boolean;
  streaming: boolean;
  /** Context window size in tokens. */
  maxContext: number;
}

export interface ProviderAdapter {
  capabilities: ProviderCapabilities;
  start(spec: SessionSpec): AgentSession;
}
