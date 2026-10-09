import type { Agent, Store, StoredEvent } from '@masterchief/core';
import { McError } from './mc-error.js';
import type { Mc } from './mc.js';
import type { SessionBackend } from './session-backend.js';

export interface WatcherOptions {
  /** Unknown state for this long after launch means the agent is probably stuck at a prompt. */
  unknownAfterSecs?: number;
  /** A busy agent with no hook event for this long is reported as stale. */
  staleAfterSecs?: number;
  /** Epoch seconds. Injectable for tests. */
  now?: () => number;
}

/** Event kinds that deserve waking the Commander. */
export const ACTIONABLE = new Set(['finished', 'blocked', 'stale', 'dead']);

interface Memory {
  unknownSince?: number;
  blockedAt?: number;
  lastStaleAt?: number;
  staleCount?: number;
}

const TAIL_LINES = 15;

/**
 * Polls the fleet without calling a model, records state changes as events, and
 * nudges the Commander session when something needs it. All state lives in the
 * database, so a restarted watcher carries on without repeating itself.
 */
export class Watcher {
  private unknownAfter: number;
  private staleAfter: number;
  private now: () => number;

  constructor(
    private mc: Mc,
    private store: Store,
    private tmux: SessionBackend,
    opts: WatcherOptions = {},
  ) {
    this.unknownAfter = opts.unknownAfterSecs ?? 90;
    this.staleAfter = opts.staleAfterSecs ?? 1800;
    this.now = opts.now ?? (() => Math.floor(Date.now() / 1000));
  }

  private memory(id: string): Memory {
    const raw = this.store.getSetting(`watch:${id}`);
    return raw ? (JSON.parse(raw) as Memory) : {};
  }
  private remember(id: string, m: Memory) {
    this.store.setSetting(`watch:${id}`, JSON.stringify(m));
  }

  private async tail(agent: Agent): Promise<string> {
    if (!agent.endpoint) return '';
    const screen = await this.tmux.capture(agent.endpoint, 60).catch(() => '');
    return screen.split('\n').slice(-TAIL_LINES).join('\n');
  }

  /** One poll of every live agent. Returns the events it recorded. */
  async tick(): Promise<StoredEvent[]> {
    const emitted: StoredEvent[] = [];
    const emit = (agent: Agent, kind: string, payload: Record<string, unknown>) => {
      const task = this.store.listMissions().flatMap((m) => this.store.listTasks(m.id)).find((t) => t.agentId === agent.id);
      emitted.push(this.store.addEvent({ missionId: task?.missionId ?? null, agentId: agent.id, kind, payload: { role: agent.role, taskId: task?.id ?? null, ...payload } }));
    };

    for (const agent of this.store.listAgents()) {
      if (agent.state === 'retired' || !agent.endpoint) continue;
      const verdict = await this.mc.verdict(agent);
      const mem = this.memory(agent.id);
      const before = JSON.stringify(mem);
      const t = this.now();

      if (verdict.state !== agent.state) {
        this.store.updateAgent(agent.id, { state: verdict.state });
        if (verdict.state === 'idle' && agent.role !== 'commander') emit(agent, 'finished', { event: verdict.event });
        if (verdict.state === 'dead') emit(agent, 'dead', { reason: verdict.source, tail: await this.tail(agent) });
        // A prompt or question is a definite signal that a person is needed, so there is nothing to wait out.
        if (verdict.state === 'waiting') emit(agent, 'blocked', { reason: 'awaiting-input', tail: await this.tail(agent) });
      }

      if (verdict.state === 'unknown') {
        mem.unknownSince ??= t;
        if (!mem.blockedAt && t - mem.unknownSince >= this.unknownAfter) {
          mem.blockedAt = t;
          emit(agent, 'blocked', { reason: verdict.source, tail: await this.tail(agent) });
        }
      } else {
        delete mem.unknownSince;
        delete mem.blockedAt;
      }

      if (verdict.state === 'busy' && verdict.since !== undefined && t - verdict.since >= this.staleAfter) {
        if (!mem.lastStaleAt || t - mem.lastStaleAt >= this.staleAfter) {
          mem.lastStaleAt = t;
          mem.staleCount = (mem.staleCount ?? 0) + 1;
          emit(agent, 'stale', { quietSecs: t - verdict.since, count: mem.staleCount, tail: await this.tail(agent) });
        }
      } else if (verdict.state !== 'busy') {
        delete mem.lastStaleAt;
        delete mem.staleCount;
      }

      if (JSON.stringify(mem) !== before) this.remember(agent.id, mem);
    }

    await this.wake();
    return emitted;
  }

  /** Nudge the Commander with a short pointer, but only between its turns and never with task text. */
  private async wake(): Promise<void> {
    // While the captain is away the afk daemon triages; the wake is delivered on return.
    if (this.store.isAfkActive()) return;
    const commander = this.store.listAgents().find((a) => a.role === 'commander' && a.state !== 'retired' && a.endpoint);
    if (!commander) return;
    const cursor = Number(this.store.getSetting('wake_cursor') ?? 0);
    const pending = this.store.listEvents({ afterSeq: cursor }).filter((e) => ACTIONABLE.has(e.kind) && e.agentId !== commander.id);
    if (!pending.length) return;
    const verdict = await this.mc.verdict(commander);
    if (verdict.state !== 'idle') return;
    const summary = pending.map((e) => `${e.kind} ${e.agentId}`).join(', ');
    // If a person is typing to the Commander, or a dialog is open, wait for the next tick.
    try {
      await this.mc.sendToAgent(commander, { text: `[mc wake] ${pending.length} new event(s): ${summary}. Run: mc events` });
    } catch (err) {
      if (err instanceof McError) return;
      throw err;
    }
    this.store.setSetting('wake_cursor', String(pending[pending.length - 1]!.seq));
  }

  /** Poll until the signal aborts. */
  async run(signal: AbortSignal, intervalMs = 2000): Promise<void> {
    while (!signal.aborted) {
      try {
        await this.tick();
      } catch (err) {
        process.stderr.write(`watch: ${(err as Error).message}\n`);
      }
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, intervalMs);
        signal.addEventListener('abort', () => (clearTimeout(timer), resolve()), { once: true });
      });
    }
  }
}
