import { open } from 'node:fs/promises';
import type { EndpointStatus } from './session-backend.js';
import type { Harness } from './harness.js';

export type BusyState = 'busy' | 'waiting' | 'idle' | 'unknown' | 'dead';

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
  // A tool is about to run, so any approval it was waiting on has been given.
  working: 'busy',
  // The CLI raised a permission prompt or a question and is waiting for a person.
  waiting: 'waiting',
  stop: 'idle',
  'stop-failure': 'idle',
  'session-end': 'dead',
};

/** Only the end of the log matters, and a long session logs a line per tool call. */
const TAIL_BYTES = 16 * 1024;

async function readTail(file: string): Promise<string | undefined> {
  let handle;
  try {
    handle = await open(file, 'r');
    const { size } = await handle.stat();
    const start = Math.max(0, size - TAIL_BYTES);
    const buf = Buffer.alloc(size - start);
    await handle.read(buf, 0, buf.length, start);
    const text = buf.toString('utf8');
    // A read that starts mid-line would parse a fragment as an event.
    return start > 0 ? text.slice(text.indexOf('\n') + 1) : text;
  } catch {
    return undefined;
  } finally {
    await handle?.close();
  }
}

/** The latest hook event written by this incarnation, or undefined. Other incarnations are ignored. */
export async function lastHookEvent(hookLog: string, gen: string): Promise<{ event: string; ts: number } | undefined> {
  const text = await readTail(hookLog);
  if (text === undefined) return undefined;
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
