import type { AgentRole } from '@masterchief/core';

export interface HarnessPrepareOptions {
  agentId: string;
  role: AgentRole;
  /** The agent's worktree. */
  cwd: string;
  /** Per-agent state outside the worktree: generated settings and hook logs. */
  stateDir: string;
  model?: string | null;
  effort?: string | null;
  /** How much the CLI may do without asking. Defaults to the harness's autonomous mode. */
  permissionMode?: string;
  /** Standing instructions added to the CLI's system prompt. */
  appendSystemPrompt?: string;
  /** Pre-register the worktree with the CLI's trust store. Pass false to leave the user's config alone. */
  trust?: false | { configFile?: string };
}

export interface HarnessLaunch {
  command: string[];
  env: Record<string, string>;
  /** Incarnation token. Hook events from any other incarnation are ignored. */
  gen: string;
  /** Where this launch's semantic busy events are written, when the harness has them. */
  hookLog: string | null;
}

/** A launch recipe for one coding CLI. It never talks to a model API. */
export interface Harness {
  id: string;
  /** Accepted effort values, or null when the CLI has no effort flag. */
  efforts: string[] | null;
  /** True when the CLI reports turn start and end through a machine-readable channel. */
  semanticBusy: boolean;
  /** Returns an error message when the model or effort cannot be launched, otherwise null. */
  validate(model: string | null | undefined, effort: string | null | undefined): string | null;
  prepare(opts: HarnessPrepareOptions): Promise<HarnessLaunch>;
  /** Text typed to leave the CLI cleanly. */
  exitText: string;
  /** Keys that interrupt the current turn. */
  interruptKeys: string[];
}

const registry = new Map<string, Harness>();

export function registerHarness(h: Harness): void {
  registry.set(h.id, h);
}

export function getHarness(id: string): Harness {
  const h = registry.get(id);
  if (!h) throw new Error(`unknown harness: ${id} (known: ${[...registry.keys()].join(', ') || 'none'})`);
  return h;
}

export function listHarnesses(): string[] {
  return [...registry.keys()];
}
