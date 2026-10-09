import type { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import type {
  Agent,
  AfkItem,
  AgentState,
  CortanaHome,
  DeliveryMode,
  Event,
  Finding,
  Mission,
  MissionStatus,
  Project,
  Review,
  Task,
  TaskKind,
  TaskStatus,
  Workspace,
} from './types.js';

type Row = Record<string, unknown>;

const toProject = (r: Row): Project => ({
  id: r.id as string,
  path: r.path as string,
  defaultBranch: r.default_branch as string,
  repoUrl: r.repo_url as string | null,
  deliveryMode: r.delivery_mode as DeliveryMode,
});

const toMission = (r: Row): Mission => ({
  id: r.id as string,
  projectId: r.project_id as string,
  type: r.type as Mission['type'],
  goal: r.goal as string,
  status: r.status as MissionStatus,
  branch: r.branch as string,
  budget: r.budget as number | null,
});

const toTask = (r: Row): Task => ({
  id: r.id as string,
  missionId: r.mission_id as string,
  title: r.title as string,
  kind: r.kind as TaskKind,
  deliveryMode: r.delivery_mode as DeliveryMode,
  agentId: r.agent_id as string | null,
  status: r.status as TaskStatus,
  dependsOn: JSON.parse(r.depends_on as string) as string[],
});

const toAgent = (r: Row): Agent => ({
  id: r.id as string,
  role: r.role as Agent['role'],
  harness: r.harness as string,
  model: r.model as string | null,
  effort: r.effort as string | null,
  endpoint: r.endpoint as string | null,
  workspaceId: r.workspace_id as string | null,
  state: r.state as AgentState,
  permanent: r.permanent === 1,
  gen: r.gen as string | null,
  hookLog: r.hook_log as string | null,
  slot: r.slot as number | null,
});

const toWorkspace = (r: Row): Workspace => ({
  id: r.id as string,
  worktreePath: r.worktree_path as string,
  branch: r.branch as string,
  baseSha: r.base_sha as string,
  access: r.access as Workspace['access'],
});

const toReview = (r: Row): Review => ({
  id: r.id as string,
  missionId: r.mission_id as string,
  taskId: r.task_id as string | null,
  by: r.by as Review['by'],
  verdict: r.verdict as Review['verdict'],
  notes: r.notes as string,
});

const toFinding = (r: Row): Finding => ({
  id: r.id as string,
  missionId: r.mission_id as string,
  claim: r.claim as string,
  evidence: r.evidence as string,
  confidence: r.confidence as number,
});

/** An event plus its insertion order, so consumers can resume after the last one seen. */
export type StoredEvent = Event & { seq: number };

const toEvent = (r: Row): StoredEvent => ({
  seq: r.seq as number,
  id: r.id as string,
  missionId: r.mission_id as string | null,
  agentId: r.agent_id as string | null,
  kind: r.kind as string,
  payload: JSON.parse(r.payload as string) as unknown,
  ts: r.ts as number,
});

const toCortana = (r: Row): CortanaHome => ({
  id: r.id as string,
  scope: r.scope as string,
  projects: JSON.parse(r.projects as string) as string[],
  homePath: r.home_path as string,
  route: r.route as CortanaHome['route'],
  harness: r.harness as string | null,
});

const toAfkItem = (r: Row): AfkItem => ({
  id: r.id as string,
  eventSeq: r.event_seq as number,
  kind: r.kind as string,
  needsHuman: r.needs_human === 1,
  agentId: r.agent_id as string | null,
  taskId: r.task_id as string | null,
  summary: r.summary as string,
  detail: r.detail as string,
  createdAt: r.created_at as number,
  archivedAt: r.archived_at as number | null,
});

const MISSION_TRANSITIONS: Record<MissionStatus, MissionStatus[]> = {
  planning: ['running', 'blocked', 'aborted'],
  running: ['blocked', 'paused', 'done', 'aborted'],
  blocked: ['running', 'aborted'],
  paused: ['running', 'aborted'],
  done: [],
  aborted: [],
};

export class Store {
  constructor(private db: DatabaseSync) {}

  createProject(p: Omit<Project, 'id' | 'deliveryMode'> & { deliveryMode?: DeliveryMode }): Project {
    const id = randomUUID();
    const deliveryMode = p.deliveryMode ?? 'direct-pr';
    this.db
      .prepare('INSERT INTO project (id, path, default_branch, repo_url, delivery_mode) VALUES (?,?,?,?,?)')
      .run(id, p.path, p.defaultBranch, p.repoUrl, deliveryMode);
    return { id, ...p, deliveryMode };
  }

  getProject(id: string): Project | undefined {
    const r = this.db.prepare('SELECT * FROM project WHERE id = ?').get(id);
    return r ? toProject(r) : undefined;
  }

  listProjects(): Project[] {
    return this.db.prepare('SELECT * FROM project ORDER BY path').all().map(toProject);
  }

  createMission(m: Omit<Mission, 'id' | 'status'>): Mission {
    const id = randomUUID();
    this.db
      .prepare(
        'INSERT INTO mission (id, project_id, type, goal, status, branch, budget) VALUES (?,?,?,?,?,?,?)',
      )
      .run(id, m.projectId, m.type, m.goal, 'planning', m.branch, m.budget);
    return { id, status: 'planning', ...m };
  }

  getMission(id: string): Mission | undefined {
    const r = this.db.prepare('SELECT * FROM mission WHERE id = ?').get(id);
    return r ? toMission(r) : undefined;
  }

  listMissions(projectId?: string): Mission[] {
    const rows = projectId
      ? this.db.prepare('SELECT * FROM mission WHERE project_id = ?').all(projectId)
      : this.db.prepare('SELECT * FROM mission').all();
    return rows.map(toMission);
  }

  setMissionStatus(id: string, next: MissionStatus): void {
    const m = this.getMission(id);
    if (!m) throw new Error(`mission not found: ${id}`);
    if (!MISSION_TRANSITIONS[m.status].includes(next)) {
      throw new Error(`invalid mission transition: ${m.status} -> ${next}`);
    }
    this.db.prepare('UPDATE mission SET status = ? WHERE id = ?').run(next, id);
  }

  /** Kind defaults to ship; delivery mode defaults to the mission's project mode. */
  createTask(
    t: Pick<Task, 'missionId' | 'title' | 'dependsOn'> & { kind?: TaskKind; deliveryMode?: DeliveryMode },
  ): Task {
    const id = randomUUID();
    const mission = this.getMission(t.missionId);
    if (!mission) throw new Error(`mission not found: ${t.missionId}`);
    const kind = t.kind ?? 'ship';
    const deliveryMode = t.deliveryMode ?? this.getProject(mission.projectId)!.deliveryMode;
    this.db
      .prepare(
        'INSERT INTO task (id, mission_id, title, kind, delivery_mode, agent_id, status, depends_on) VALUES (?,?,?,?,?,?,?,?)',
      )
      .run(id, t.missionId, t.title, kind, deliveryMode, null, 'pending', JSON.stringify(t.dependsOn));
    return { id, missionId: t.missionId, title: t.title, kind, deliveryMode, status: 'pending', agentId: null, dependsOn: t.dependsOn };
  }

  getTask(id: string): Task | undefined {
    const r = this.db.prepare('SELECT * FROM task WHERE id = ?').get(id);
    return r ? toTask(r) : undefined;
  }

  assignTask(taskId: string, agentId: string | null): void {
    this.db.prepare('UPDATE task SET agent_id = ? WHERE id = ?').run(agentId, taskId);
  }

  listTasks(missionId: string): Task[] {
    return this.db.prepare('SELECT * FROM task WHERE mission_id = ?').all(missionId).map(toTask);
  }

  setTaskStatus(id: string, status: TaskStatus): void {
    this.db.prepare('UPDATE task SET status = ? WHERE id = ?').run(status, id);
  }

  createAgent(a: {
    id?: string;
    role: Agent['role'];
    harness: string;
    model?: string | null;
    effort?: string | null;
    permanent?: boolean;
    workspaceId?: string | null;
    endpoint?: string | null;
    gen?: string | null;
    hookLog?: string | null;
    slot?: number | null;
  }): Agent {
    const id = a.id ?? randomUUID();
    const agent: Agent = {
      id,
      role: a.role,
      harness: a.harness,
      model: a.model ?? null,
      effort: a.effort ?? null,
      endpoint: a.endpoint ?? null,
      workspaceId: a.workspaceId ?? null,
      state: 'starting',
      permanent: a.permanent ?? (a.role === 'commander' || a.role === 'cortana'),
      gen: a.gen ?? null,
      hookLog: a.hookLog ?? null,
      slot: a.slot ?? null,
    };
    this.db
      .prepare(
        'INSERT INTO agent (id, role, workspace_id, state, permanent, harness, model, effort, endpoint, gen, hook_log, slot) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
      )
      .run(id, agent.role, agent.workspaceId, agent.state, agent.permanent ? 1 : 0, agent.harness, agent.model, agent.effort, agent.endpoint, agent.gen, agent.hookLog, agent.slot);
    return agent;
  }

  getAgent(id: string): Agent | undefined {
    const r = this.db.prepare('SELECT * FROM agent WHERE id = ?').get(id);
    return r ? toAgent(r) : undefined;
  }

  listAgents(): Agent[] {
    return this.db.prepare('SELECT * FROM agent ORDER BY rowid').all().map(toAgent);
  }

  updateAgent(
    id: string,
    patch: {
      state?: AgentState;
      endpoint?: string | null;
      workspaceId?: string | null;
      gen?: string | null;
      hookLog?: string | null;
      slot?: number | null;
    },
  ): void {
    if (!this.getAgent(id)) throw new Error(`agent not found: ${id}`);
    const sets: string[] = [];
    const vals: (string | number | null)[] = [];
    if (patch.state !== undefined) (sets.push('state = ?'), vals.push(patch.state));
    if (patch.endpoint !== undefined) (sets.push('endpoint = ?'), vals.push(patch.endpoint));
    if (patch.workspaceId !== undefined) (sets.push('workspace_id = ?'), vals.push(patch.workspaceId));
    if (patch.gen !== undefined) (sets.push('gen = ?'), vals.push(patch.gen));
    if (patch.hookLog !== undefined) (sets.push('hook_log = ?'), vals.push(patch.hookLog));
    if (patch.slot !== undefined) (sets.push('slot = ?'), vals.push(patch.slot));
    if (!sets.length) return;
    this.db.prepare(`UPDATE agent SET ${sets.join(', ')} WHERE id = ?`).run(...vals, id);
  }

  /** Smallest slot not held by an agent, for per-agent ports and temp dirs. A slot is held until teardown. */
  allocateSlot(): number {
    const used = new Set(this.listAgents().flatMap((a) => (a.slot === null ? [] : [a.slot])));
    let n = 0;
    while (used.has(n)) n++;
    return n;
  }

  deleteAgent(id: string): void {
    this.db.prepare('DELETE FROM agent WHERE id = ?').run(id);
  }

  saveWorkspace(ws: Workspace): void {
    this.db
      .prepare(
        'INSERT OR REPLACE INTO workspace (id, worktree_path, branch, base_sha, access) VALUES (?,?,?,?,?)',
      )
      .run(ws.id, ws.worktreePath, ws.branch, ws.baseSha, ws.access);
  }

  getWorkspace(id: string): Workspace | undefined {
    const r = this.db.prepare('SELECT * FROM workspace WHERE id = ?').get(id);
    return r ? toWorkspace(r) : undefined;
  }

  deleteWorkspace(id: string): void {
    this.db.prepare('DELETE FROM workspace WHERE id = ?').run(id);
  }

  addReview(r: Omit<Review, 'id' | 'taskId'> & { taskId?: string | null }): Review {
    const id = randomUUID();
    const taskId = r.taskId ?? null;
    this.db
      .prepare('INSERT INTO review (id, mission_id, task_id, by, verdict, notes) VALUES (?,?,?,?,?,?)')
      .run(id, r.missionId, taskId, r.by, r.verdict, r.notes);
    return { id, ...r, taskId };
  }

  /** The most recent verdict about a task, from anyone. */
  latestReview(taskId: string): Review | undefined {
    const r = this.db.prepare('SELECT * FROM review WHERE task_id = ? ORDER BY rowid DESC LIMIT 1').get(taskId);
    return r ? toReview(r) : undefined;
  }

  listReviews(missionId: string): Review[] {
    return this.db.prepare('SELECT * FROM review WHERE mission_id = ? ORDER BY rowid').all(missionId).map(toReview);
  }

  addFinding(f: Omit<Finding, 'id'>): Finding {
    const id = randomUUID();
    this.db
      .prepare('INSERT INTO finding (id, mission_id, claim, evidence, confidence) VALUES (?,?,?,?,?)')
      .run(id, f.missionId, f.claim, f.evidence, f.confidence);
    return { id, ...f };
  }

  listFindings(missionId: string): Finding[] {
    return this.db.prepare('SELECT * FROM finding WHERE mission_id = ? ORDER BY rowid').all(missionId).map(toFinding);
  }

  addEvent(e: Omit<Event, 'id' | 'ts'> & { ts?: number }): StoredEvent {
    const id = randomUUID();
    const ts = e.ts ?? Date.now();
    this.db
      .prepare('INSERT INTO event (id, mission_id, agent_id, kind, payload, ts) VALUES (?,?,?,?,?,?)')
      .run(id, e.missionId, e.agentId, e.kind, JSON.stringify(e.payload ?? null), ts);
    const r = this.db.prepare('SELECT rowid AS seq, * FROM event WHERE id = ?').get(id)!;
    return toEvent(r);
  }

  /** Events in insertion order. Pass the last seq you saw to get only newer ones. */
  listEvents(opts: { afterSeq?: number; missionId?: string; limit?: number } = {}): StoredEvent[] {
    const where: string[] = ['rowid > ?'];
    const vals: (string | number)[] = [opts.afterSeq ?? 0];
    if (opts.missionId) (where.push('mission_id = ?'), vals.push(opts.missionId));
    const limit = opts.limit ?? 1000;
    return this.db
      .prepare(`SELECT rowid AS seq, * FROM event WHERE ${where.join(' AND ')} ORDER BY rowid LIMIT ${limit}`)
      .all(...vals)
      .map(toEvent);
  }

  getSetting(key: string): string | undefined {
    const r = this.db.prepare('SELECT value FROM setting WHERE key = ?').get(key);
    return r ? (r.value as string) : undefined;
  }

  setSetting(key: string, value: string): void {
    this.db.prepare('INSERT OR REPLACE INTO setting (key, value) VALUES (?,?)').run(key, value);
  }

  isAfkActive(): boolean {
    return this.getSetting('afk_active') === '1';
  }

  setAfkActive(active: boolean): void {
    this.setSetting('afk_active', active ? '1' : '0');
  }

  createCortanaHome(c: Omit<CortanaHome, 'id'> & { id?: string }): CortanaHome {
    const id = c.id ?? randomUUID();
    this.db
      .prepare('INSERT INTO cortana_home (id, scope, projects, home_path, route, harness) VALUES (?,?,?,?,?,?)')
      .run(id, c.scope, JSON.stringify(c.projects), c.homePath, c.route, c.harness);
    return { ...c, id };
  }

  getCortanaHome(id: string): CortanaHome | undefined {
    const r = this.db.prepare('SELECT * FROM cortana_home WHERE id = ?').get(id);
    return r ? toCortana(r) : undefined;
  }

  listCortanaHomes(): CortanaHome[] {
    return this.db.prepare('SELECT * FROM cortana_home ORDER BY rowid').all().map(toCortana);
  }

  deleteCortanaHome(id: string): void {
    this.db.prepare('DELETE FROM cortana_home WHERE id = ?').run(id);
  }

  /** Record an afk item once per event. Returns undefined if that event was already recorded. */
  addAfkItem(i: Omit<AfkItem, 'id' | 'createdAt' | 'archivedAt'> & { createdAt?: number }): AfkItem | undefined {
    const id = randomUUID();
    const createdAt = i.createdAt ?? Date.now();
    const res = this.db
      .prepare(
        'INSERT OR IGNORE INTO afk_item (id, event_seq, kind, needs_human, agent_id, task_id, summary, detail, created_at) VALUES (?,?,?,?,?,?,?,?,?)',
      )
      .run(id, i.eventSeq, i.kind, i.needsHuman ? 1 : 0, i.agentId, i.taskId, i.summary, i.detail, createdAt);
    return res.changes ? { id, ...i, createdAt, archivedAt: null } : undefined;
  }

  /** Items not yet handed to the human, oldest first. */
  listAfkItems(): AfkItem[] {
    return this.db.prepare('SELECT * FROM afk_item WHERE archived_at IS NULL ORDER BY event_seq').all().map(toAfkItem);
  }

  archiveAfkItems(at = Date.now()): number {
    return Number(this.db.prepare('UPDATE afk_item SET archived_at = ? WHERE archived_at IS NULL').run(at).changes);
  }
}
