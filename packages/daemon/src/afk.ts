import { spawn as spawnProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { open as openFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AfkItem, Store, StoredEvent } from '@masterchief/core';
import { McError } from './mc-error.js';
import type { Mc } from './mc.js';
import { ACTIONABLE } from './watcher.js';

const LOCK = 'afk.pid';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface AfkBrief {
  startedAt: number;
  endedAt: number | null;
  minutes: number;
  note: string | null;
  /** Things that need the human to decide. */
  needsYou: Pick<AfkItem, 'kind' | 'summary' | 'agentId' | 'taskId' | 'detail'>[];
  /** What happened that needs no decision. */
  activity: Pick<AfkItem, 'kind' | 'summary' | 'agentId' | 'taskId'>[];
  text: string;
}

/**
 * Optional away mode. While it is on, the Commander is not woken. A separate loop
 * records each wake as a queued item: finished work waiting for review, or something
 * that needs a human. It never lands, interrupts, respawns or answers anything; it
 * only sorts and remembers, and hands a brief over on return.
 */
export class Afk {
  constructor(private mc: Mc) {}

  private get store(): Store {
    return this.mc.d.store;
  }

  private latestSeq(): number {
    return this.store.listEvents().at(-1)?.seq ?? 0;
  }

  async status() {
    const lock = await this.mc.lockStatus(LOCK);
    return {
      active: this.store.isAfkActive(),
      startedAt: this.num('afk_started_at'),
      daemon: lock,
      queued: this.store.listAfkItems().length,
      needYou: this.store.listAfkItems().filter((i) => i.needsHuman).length,
    };
  }

  private num(key: string): number | null {
    const v = this.store.getSetting(key);
    return v === undefined ? null : Number(v);
  }

  /** Turn away mode on and start its daemon. Events from now on are triaged. */
  async start(o: { note?: string } = {}) {
    if (this.store.isAfkActive()) throw new McError('away mode is already on');
    this.store.setAfkActive(true);
    this.store.setSetting('afk_started_at', String(Date.now()));
    this.store.setSetting('afk_note', o.note ?? '');
    this.store.setSetting('afk_cursor', String(this.latestSeq()));
    await this.mc.ensureWatcherBackground().catch(() => undefined);
    const daemon = await this.ensureDaemon();
    return { active: true, daemon };
  }

  private async ensureDaemon() {
    const now = await this.mc.lockStatus(LOCK);
    if (now.running) return { ...now, started: false };
    const cli = this.mc.d.cliPath;
    if (!cli) return { running: false, started: false };
    const log = await openFile(join(this.mc.d.home, 'afk.log'), 'a');
    const child = spawnProcess(process.execPath, ['--disable-warning=ExperimentalWarning', cli, 'afk', 'run'], {
      detached: true,
      stdio: ['ignore', log.fd, log.fd],
      env: { ...process.env, MC_HOME: this.mc.d.home, ...this.mc.d.extraEnv },
    });
    child.unref();
    await log.close();
    for (let i = 0; i < 40; i++) {
      await sleep(50);
      const s = await this.mc.lockStatus(LOCK);
      if (s.running) return { ...s, started: true };
    }
    throw new McError(`the afk daemon did not start; see ${join(this.mc.d.home, 'afk.log')}`);
  }

  private async stopDaemon() {
    const s = await this.mc.lockStatus(LOCK);
    if (!s.running) return;
    process.kill(s.pid!, 'SIGTERM');
    for (let i = 0; i < 60; i++) {
      await sleep(50);
      if (!(await this.mc.lockStatus(LOCK)).running) return;
    }
  }

  /** Turn one wake event into a queued item, or nothing. */
  private async classify(e: StoredEvent): Promise<Omit<AfkItem, 'id' | 'createdAt' | 'archivedAt'> | undefined> {
    if (!ACTIONABLE.has(e.kind) && e.kind !== 'landed') return undefined;
    const p = (e.payload ?? {}) as Record<string, unknown>;
    const agentId = e.agentId;
    if (agentId === 'commander') return undefined;
    const taskId = (p.taskId as string | null | undefined) ?? null;
    const task = taskId ? this.store.getTask(taskId) : undefined;
    const title = task ? ` "${task.title}"` : '';
    const role = (p.role as string | undefined) ?? '';
    const item = (kind: string, needsHuman: boolean, summary: string, detail = '') => ({ eventSeq: e.seq, kind, needsHuman, agentId, taskId, summary, detail });

    switch (e.kind) {
      case 'finished':
        if (role === 'cortana') return item('cortana-report', false, `Cortana ${agentId} ended a turn; read her status`);
        if (role === 'sentinel') {
          const report = taskId ? join(this.mc.dataDir, taskId, 'report.md') : '';
          return item('report', false, `sentinel ${agentId} finished${title}; report ${existsSync(report) ? 'written' : 'not written'}`);
        }
        return item('ready', false, `pilot ${agentId} finished${title}: ready for review`);
      case 'blocked':
        return item(
          'blocked',
          true,
          p.reason === 'awaiting-input'
            ? `${agentId} is waiting for input (a permission prompt or a question)${title}`
            : `${agentId} looks stuck (${String(p.reason ?? 'no signal')}), probably at a prompt`,
          String(p.tail ?? ''),
        );
      case 'dead': {
        let extra = '';
        const agent = agentId ? this.store.getAgent(agentId) : undefined;
        const ws = agent?.workspaceId ? this.store.getWorkspace(agent.workspaceId) : undefined;
        const mission = task ? this.store.getMission(task.missionId) : undefined;
        const project = mission ? this.store.getProject(mission.projectId) : undefined;
        if (ws && project) {
          const reasons = await this.mc.unlandedWork(project, ws).catch(() => []);
          if (reasons.length) extra = `; it left unlanded work: ${reasons.join('; ')}`;
        }
        return item('dead', true, `${agentId} exited${title}${extra}`, String(p.tail ?? ''));
      }
      case 'stale': {
        const count = Number(p.count ?? 1);
        return item('stale', count >= 2, `${agentId} has been busy a long time with no progress (report ${count})`, String(p.tail ?? ''));
      }
      case 'landed':
        return item('landed', false, `task${title} was landed (${String(p.mode ?? '')})`);
      default:
        return undefined;
    }
  }

  /** Triage every event since the last pass. Returns the items it queued. */
  async process(): Promise<AfkItem[]> {
    const cursor = Number(this.store.getSetting('afk_cursor') ?? 0);
    const queued: AfkItem[] = [];
    for (const e of this.store.listEvents({ afterSeq: cursor })) {
      const draft = await this.classify(e);
      if (draft) {
        const saved = this.store.addAfkItem(draft);
        if (saved) queued.push(saved);
      }
      this.store.setSetting('afk_cursor', String(e.seq));
    }
    return queued;
  }

  brief(o: { last?: boolean } = {}): AfkBrief {
    if (o.last) {
      const raw = this.store.getSetting('afk_last_brief');
      if (!raw) throw new McError('there is no previous away brief');
      return JSON.parse(raw) as AfkBrief;
    }
    return this.build(this.store.listAfkItems(), null);
  }

  private build(items: AfkItem[], endedAt: number | null): AfkBrief {
    const startedAt = this.num('afk_started_at') ?? Date.now();
    const note = this.store.getSetting('afk_note') || null;
    const needsYou = items.filter((i) => i.needsHuman).map(({ kind, summary, agentId, taskId, detail }) => ({ kind, summary, agentId, taskId, detail }));
    const activity = items.filter((i) => !i.needsHuman).map(({ kind, summary, agentId, taskId }) => ({ kind, summary, agentId, taskId }));
    const minutes = Math.max(0, Math.round(((endedAt ?? Date.now()) - startedAt) / 60000));
    const lines = [`Away for ${minutes} minute(s)${note ? ` (${note})` : ''}.`];
    lines.push(needsYou.length ? `${needsYou.length} item(s) need you:` : 'Nothing needs a decision.');
    for (const i of needsYou) lines.push(`- ${i.summary}${i.agentId ? `  [mc status ${i.agentId}]` : ''}`);
    if (activity.length) lines.push(`${activity.length} other event(s):`, ...activity.map((i) => `- ${i.summary}`));
    return { startedAt, endedAt, minutes, note, needsYou, activity, text: lines.join('\n') };
  }

  /** Turn away mode off, hand over the brief, and tell the Commander once. */
  async stop() {
    if (!this.store.isAfkActive()) throw new McError('away mode is not on');
    await this.stopDaemon();
    await this.process();
    const items = this.store.listAfkItems();
    const brief = this.build(items, Date.now());
    this.store.setSetting('afk_last_brief', JSON.stringify(brief));
    this.store.archiveAfkItems();
    this.store.setAfkActive(false);
    // Everything up to now is covered by the brief, so the normal wake must not replay it.
    this.store.setSetting('wake_cursor', String(this.latestSeq()));
    const commander = this.store.listAgents().find((a) => a.role === 'commander' && a.state !== 'retired' && a.endpoint);
    if (commander && items.length && (await this.mc.verdict(commander)).state === 'idle') {
      await this.mc.sendToAgent(commander, { text: `[mc afk-return] ${items.length} item(s) queued while the captain was away, ${brief.needsYou.length} need a decision. Run: mc afk brief --last` });
    }
    return brief;
  }

  /** The daemon loop. Holds a single-instance lock. */
  async run(signal: AbortSignal, intervalMs = 2000) {
    if (!this.store.isAfkActive()) throw new McError('away mode is not on (start it with: mc afk start)');
    const release = await this.mc.acquireLock(LOCK, 'the afk daemon');
    try {
      while (!signal.aborted && this.store.isAfkActive()) {
        try {
          await this.process();
        } catch (err) {
          process.stderr.write(`afk: ${(err as Error).message}\n`);
        }
        await new Promise<void>((resolve) => {
          const t = setTimeout(resolve, intervalMs);
          signal.addEventListener('abort', () => (clearTimeout(t), resolve()), { once: true });
        });
      }
    } finally {
      await release();
    }
  }
}
