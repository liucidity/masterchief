import type { ProviderCapabilities } from './types.js';

export interface TaskNeeds {
  tools: boolean;
  streaming: boolean;
  /** Estimated context the task needs, in tokens. */
  contextTokens: number;
}

export type CapabilityCheck = { ok: true } | { ok: false; reasons: string[] };

/** Typed rejection when an adapter cannot do what a task needs. The Commander decides what happens next. */
export function checkCapabilities(caps: ProviderCapabilities, needs: TaskNeeds): CapabilityCheck {
  const reasons: string[] = [];
  if (needs.tools && !caps.tools) reasons.push('tool use is not supported');
  if (needs.streaming && !caps.streaming) reasons.push('streaming is not supported');
  if (needs.contextTokens > caps.maxContext) {
    reasons.push(`needs ${needs.contextTokens} tokens of context, adapter allows ${caps.maxContext}`);
  }
  return reasons.length ? { ok: false, reasons } : { ok: true };
}
