import { readFile } from 'node:fs/promises';
import type { EndpointStatus } from './session-backend.js';
import type { Harness } from './harness.js';

export type BusyState = 'busy' | 'idle' | 'unknown' | 'dead';

export interface BusyVerdict {
  state: BusyState;
  /** What produced the verdict, so a fallback is never mistaken for a semantic reading. */
  source: string;
  /** The hook event behind the verdict, when there was one. */
  event?: string;
  /** Epoch seconds of that event. */
  since?: number;
}

const EVENT_STATE: Record<string, BusyState> = {
  prompt: 'busy',
  stop: 'idle',
  'stop-failure': 'idle',
  'session-end': 'dead',
};

/** The latest hook event written by this incarnation, or undefined. Other incarnations are ignored. */
export async function lastHookEvent(hookLog: string, gen: string): Promise<{ event: string; ts: number } | undefined> {
  let text: string;
  try {
    text = await readFile(hookLog, 'utf8');
  } catch {
    return undefined;
  }
  let last: { event: string; ts: number } | undefined;
  for (const line of text.split('\n')) {
    const [g, ts, event] = line.split(' ');
    if (g === gen && event && EVENT_STATE[event] && Number.isFinite(Number(ts))) {
      last = { event, ts: Number(ts) };
    }
  }
  return last;
}

/**
 * Decide whether an agent is busy, idle, unknown or dead. A gone process always
 * wins. Missing, stale or unverifiable state is unknown, never idle or busy.
 */
export async function classifyAgent(args: {
  harness: Harness;
  endpoint: EndpointStatus;
  hookLog: string | null;
  gen: string | null;
}): Promise<BusyVerdict> {
  if (args.endpoint === 'missing') return { state: 'dead', source: 'endpoint-missing' };
  if (args.endpoint === 'dead') return { state: 'dead', source: 'endpoint-exited' };
  if (!args.harness.semanticBusy) return { state: 'unknown', source: 'no-semantic-source' };
  if (!args.hookLog || !args.gen) return { state: 'unknown', source: 'no-hook-record' };
  const last = await lastHookEvent(args.hookLog, args.gen);
  if (!last) return { state: 'unknown', source: 'no-events-yet' };
  return { state: EVENT_STATE[last.event]!, source: 'hooks', event: last.event, since: last.ts };
}
