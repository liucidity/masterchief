import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Store, type Agent, type Event, type Mission } from '@masterchief/core';

export interface MissionRow {
  id: string;
  type: Mission['type'];
  status: Mission['status'];
  goal: string;
  done: number;
  total: number;
}

export interface CrewRow {
  id: string;
  role: Agent['role'];
  harness: string;
  model: string | null;
  effort: string | null;
  state: Agent['state'];
  task: string | null;
}

export interface CortanaRow {
  id: string;
  scope: string;
  /** Whether her session is tracked as live in this database. */
  state: Agent['state'] | 'stopped';
  crew: number | null;
}

export interface AlertRow {
  at: number;
  kind: string;
  agent: string | null;
  text: string;
}

export interface Snapshot {
  home: string;
  now: number;
  watcher: { running: boolean; pid?: number };
  afk: { active: boolean; since: number | null; queued: number; needYou: number };
  missions: MissionRow[];
  crew: CrewRow[];
  cortana: CortanaRow[];
  alerts: AlertRow[];
}

const ALERT_KINDS = new Set(['finished', 'blocked', 'dead', 'stale', 'landed']);

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function lock(home: string, name: string): Promise<{ running: boolean; pid?: number }> {
  try {
    const { readFile } = await import('node:fs/promises');
    const pid = Number(await readFile(join(home, name), 'utf8'));
    return pid > 0 && alive(pid) ? { running: true, pid } : { running: false };
  } catch {
    return { running: false };
  }
}

/** Open a home's database for reading only, so the view can never disturb a running fleet. */
export function openReadOnly(home: string): Store | undefined {
  const file = join(home, 'mc.db');
  if (!existsSync(file)) return undefined;
  const db = new DatabaseSync(file, { readOnly: true });
  db.exec('PRAGMA busy_timeout = 2000');
  return new Store(db);
}

function describe(e: Event): string {
  const p = (e.payload ?? {}) as Record<string, unknown>;
  switch (e.kind) {
    case 'finished':
      return 'ended a turn';
    case 'blocked':
      return `looks stuck (${String(p.reason ?? 'no signal')})`;
    case 'dead':
      return `exited (${String(p.reason ?? 'process gone')})`;
    case 'stale':
      return `busy with no progress (report ${String(p.count ?? 1)})`;
    case 'landed':
      return `landed (${String(p.mode ?? '')})`;
    default:
      return e.kind;
  }
}

/** Everything the view shows, read straight from the database and lock files. */
export async function takeSnapshot(home: string, store: Store, now = Date.now(), opts: { alerts?: number } = {}): Promise<Snapshot> {
  const missions = store.listMissions().map((m) => {
    const tasks = store.listTasks(m.id);
    return { id: m.id, type: m.type, status: m.status, goal: m.goal, done: tasks.filter((t) => t.status === 'done').length, total: tasks.length };
  });

  const allTasks = store.listMissions().flatMap((m) => store.listTasks(m.id));
  const taskOf = new Map(allTasks.filter((t) => t.agentId).map((t) => [t.agentId!, t.title]));
  const agents = store.listAgents();
  const crew = agents
    .filter((a) => a.state !== 'retired')
    .map((a) => ({ id: a.id, role: a.role, harness: a.harness, model: a.model, effort: a.effort, state: a.state, task: taskOf.get(a.id) ?? null }));

  const cortana = store.listCortanaHomes().map((c): CortanaRow => {
    const agent = agents.find((a) => a.id === `cortana-${c.id}`);
    let crewCount: number | null = null;
    try {
      const her = openReadOnly(c.homePath);
      if (her) {
        const herTasks = her.listMissions().flatMap((m) => her.listTasks(m.id));
        const live = new Set(her.listAgents().filter((a) => a.state !== 'retired' && a.role !== 'commander').map((a) => a.id));
        crewCount = herTasks.filter((t) => t.agentId && live.has(t.agentId)).length;
      }
    } catch {
      crewCount = null;
    }
    return { id: c.id, scope: c.scope, state: agent && agent.state !== 'retired' ? agent.state : 'stopped', crew: crewCount };
  });

  const alerts = store
    .listEvents({ limit: 5000 })
    .filter((e) => ALERT_KINDS.has(e.kind))
    .sort((a, b) => a.ts - b.ts || a.seq - b.seq)
    .slice(-(opts.alerts ?? 12))
    .reverse()
    .map((e) => ({ at: e.ts, kind: e.kind, agent: e.agentId, text: describe(e) }));

  const items = store.listAfkItems();
  const since = store.getSetting('afk_started_at');
  return {
    home,
    now,
    watcher: await lock(home, 'watch.pid'),
    afk: { active: store.isAfkActive(), since: since ? Number(since) : null, queued: items.length, needYou: items.filter((i) => i.needsHuman).length },
    missions,
    crew,
    cortana,
    alerts,
  };
}
