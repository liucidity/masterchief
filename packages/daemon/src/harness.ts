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
  /** Tool patterns the CLI may use without asking, for example Bash(mc *). */
  allowTools?: string[];
  /** Tools removed from the CLI entirely. */
  denyTools?: string[];
  /** Program and arguments the CLI runs before every tool call; exit code 2 blocks the call. */
  guardCommand?: string[];
  /** Continue the most recent conversation in this directory instead of starting fresh. */
  resume?: boolean;
  /** The first message the agent receives, delivered at launch so no ready-detection is needed. */
  initialPrompt?: string;
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

/** Whether it is safe to type into an agent: its input box is empty, holds a draft, or cannot be read. */
export type ComposerState = 'empty' | 'typing' | 'unknown';

/** A launch recipe for one coding CLI. It never talks to a model API. */
export interface Harness {
  id: string;
  /**
   * True when the CLI cannot report that a turn started. MasterChief then writes the
   * prompt event itself whenever it launches the agent with a brief or sends it text.
   */
  recordsSends?: boolean;
  /** Accepted effort values, or null when the CLI has no effort flag. */
  efforts: string[] | null;
  /** True when the CLI reports turn start and end through a machine-readable channel. */
  semanticBusy: boolean;
  /** Returns an error message when the model or effort cannot be launched, otherwise null. */
  validate(model: string | null | undefined, effort: string | null | undefined): string | null;
  prepare(opts: HarnessPrepareOptions): Promise<HarnessLaunch>;
  /**
   * Read a screen capture and say whether the input box is empty. Typing into anything else, a
   * draft or a dialog, would corrupt a person's input or answer a prompt, so text is only sent
   * when this says `empty`. Harnesses without it are treated as always ready.
   */
  composerState?(screen: string): ComposerState;
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
