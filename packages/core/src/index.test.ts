import { beforeEach, expect, test } from 'vitest';
import { openDb, Store } from './index.js';

let store: Store;
beforeEach(() => {
  store = new Store(openDb());
});

const project = () => store.createProject({ path: '/p', defaultBranch: 'main', repoUrl: null });

test('project round trip', () => {
  const p = project();
  expect(store.getProject(p.id)).toEqual(p);
  expect(store.listProjects()).toHaveLength(1);
});

test('mission starts in planning and follows valid transitions', () => {
  const m = store.createMission({
    projectId: project().id,
    type: 'build',
    goal: 'Add OAuth login',
    branch: 'mc/oauth',
    budget: null,
  });
  expect(m.status).toBe('planning');
  store.setMissionStatus(m.id, 'running');
  store.setMissionStatus(m.id, 'done');
  expect(store.getMission(m.id)?.status).toBe('done');
});

test('invalid mission transition throws', () => {
  const m = store.createMission({
    projectId: project().id,
    type: 'investigate',
    goal: 'why slow',
    branch: 'mc/slow',
    budget: 5,
  });
  expect(() => store.setMissionStatus(m.id, 'done')).toThrow(/invalid mission transition/);
});

test('mission requires an existing project', () => {
  expect(() =>
    store.createMission({ projectId: 'nope', type: 'build', goal: 'x', branch: 'b', budget: null }),
  ).toThrow();
});

test('tasks keep dependencies and status', () => {
  const m = store.createMission({
    projectId: project().id,
    type: 'build',
    goal: 'g',
    branch: 'b',
    budget: null,
  });
  const a = store.createTask({ missionId: m.id, title: 'a', dependsOn: [] });
  const b = store.createTask({ missionId: m.id, title: 'b', dependsOn: [a.id] });
  store.setTaskStatus(a.id, 'done');
  const tasks = store.listTasks(m.id);
  expect(tasks.find((t) => t.id === a.id)?.status).toBe('done');
  expect(tasks.find((t) => t.id === b.id)?.dependsOn).toEqual([a.id]);
});

test('tasks default to ship and inherit the project delivery mode', () => {
  const p = store.createProject({ path: '/q', defaultBranch: 'main', repoUrl: null, deliveryMode: 'local-only' });
  const m = store.createMission({ projectId: p.id, type: 'build', goal: 'g', branch: 'b', budget: null });
  const t = store.createTask({ missionId: m.id, title: 't', dependsOn: [] });
  expect(t.kind).toBe('ship');
  expect(t.deliveryMode).toBe('local-only');
  const s = store.createTask({ missionId: m.id, title: 's', dependsOn: [], kind: 'sentinel', deliveryMode: 'direct-pr' });
  expect(store.getTask(s.id)).toMatchObject({ kind: 'sentinel', deliveryMode: 'direct-pr' });
});

test('agents carry harness, model, effort and endpoint, and can be updated', () => {
  const a = store.createAgent({ role: 'pilot', harness: 'claude', model: 'opus', effort: 'high' });
  expect(a).toMatchObject({ state: 'starting', permanent: false, endpoint: null });
  store.updateAgent(a.id, { state: 'busy', endpoint: 'mc:pilot-1' });
  expect(store.getAgent(a.id)).toMatchObject({ state: 'busy', endpoint: 'mc:pilot-1', model: 'opus' });
  expect(store.createAgent({ role: 'commander', harness: 'claude' }).permanent).toBe(true);
  expect(() => store.updateAgent('nope', { state: 'idle' })).toThrow(/not found/);
});

test('assigning a task to an agent', () => {
  const m = store.createMission({ projectId: project().id, type: 'build', goal: 'g', branch: 'b', budget: null });
  const t = store.createTask({ missionId: m.id, title: 't', dependsOn: [] });
  const a = store.createAgent({ role: 'pilot', harness: 'claude' });
  store.assignTask(t.id, a.id);
  expect(store.getTask(t.id)?.agentId).toBe(a.id);
});

test('workspaces round trip and reviews, findings and events are ordered', () => {
  const ws = { id: 'w1', worktreePath: '/wt', branch: 'mc/m/w1', baseSha: 'abc', access: 'rw' as const };
  store.saveWorkspace(ws);
  expect(store.getWorkspace('w1')).toEqual(ws);
  store.deleteWorkspace('w1');
  expect(store.getWorkspace('w1')).toBeUndefined();

  const m = store.createMission({ projectId: project().id, type: 'investigate', goal: 'g', branch: 'b', budget: null });
  store.addReview({ missionId: m.id, by: 'commander', verdict: 'approve', notes: 'ok' });
  expect(store.listReviews(m.id)[0]!.taskId).toBeNull();
  store.addFinding({ missionId: m.id, claim: 'c', evidence: 'e', confidence: 0.5 });
  expect(store.listReviews(m.id)).toHaveLength(1);
  expect(store.listFindings(m.id)[0]).toMatchObject({ claim: 'c' });

  const e1 = store.addEvent({ missionId: m.id, agentId: null, kind: 'idle', payload: { n: 1 } });
  const e2 = store.addEvent({ missionId: null, agentId: 'a', kind: 'dead', payload: null });
  expect(store.listEvents().map((e) => e.kind)).toEqual(['idle', 'dead']);
  expect(store.listEvents({ afterSeq: e1.seq }).map((e) => e.id)).toEqual([e2.id]);
  expect(store.listEvents({ missionId: m.id })).toHaveLength(1);
});

test('afk setting defaults off and toggles', () => {
  expect(store.isAfkActive()).toBe(false);
  store.setAfkActive(true);
  expect(store.isAfkActive()).toBe(true);
  store.setAfkActive(false);
  expect(store.isAfkActive()).toBe(false);
});

test('cortana homes keep scope, projects and local route', () => {
  const c = store.createCortanaHome({ scope: 'issue triage', projects: ['a', 'b'], homePath: '/h', route: 'local', harness: null });
  expect(store.getCortanaHome(c.id)).toEqual(c);
  expect(store.listCortanaHomes()).toHaveLength(1);
  store.deleteCortanaHome(c.id);
  expect(store.listCortanaHomes()).toHaveLength(0);
});

test('migration 2 upgrades a database created by migration 1', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const path = join(mkdtempSync(join(tmpdir(), 'mc-db-')), 'old.db');
  const old = new DatabaseSync(path);
  old.exec(`CREATE TABLE project (id TEXT PRIMARY KEY, path TEXT NOT NULL, default_branch TEXT NOT NULL, repo_url TEXT);
    CREATE TABLE mission (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES project(id), type TEXT NOT NULL, goal TEXT NOT NULL, status TEXT NOT NULL, branch TEXT NOT NULL, budget REAL);
    CREATE TABLE workspace (id TEXT PRIMARY KEY, worktree_path TEXT NOT NULL, branch TEXT NOT NULL, base_sha TEXT NOT NULL, access TEXT NOT NULL);
    CREATE TABLE agent (id TEXT PRIMARY KEY, role TEXT NOT NULL, session_id TEXT, workspace_id TEXT REFERENCES workspace(id), state TEXT NOT NULL, permanent INTEGER NOT NULL);
    CREATE TABLE task (id TEXT PRIMARY KEY, mission_id TEXT NOT NULL REFERENCES mission(id), title TEXT NOT NULL, agent_id TEXT REFERENCES agent(id), status TEXT NOT NULL, depends_on TEXT NOT NULL DEFAULT '[]');
    CREATE TABLE review (id TEXT PRIMARY KEY, mission_id TEXT NOT NULL REFERENCES mission(id), by TEXT NOT NULL, verdict TEXT NOT NULL, notes TEXT NOT NULL);
    CREATE TABLE finding (id TEXT PRIMARY KEY, mission_id TEXT NOT NULL REFERENCES mission(id), claim TEXT NOT NULL, evidence TEXT NOT NULL, confidence REAL NOT NULL);
    CREATE TABLE event (id TEXT PRIMARY KEY, mission_id TEXT NOT NULL REFERENCES mission(id), agent_id TEXT, kind TEXT NOT NULL, payload TEXT NOT NULL, ts INTEGER NOT NULL);
    INSERT INTO agent VALUES ('a1','engineer','s1',NULL,'working',0), ('a2','investigator',NULL,NULL,'failed',0);
    PRAGMA user_version = 1;`);
  old.close();
  const upgraded = new Store(openDb(path));
  expect(upgraded.getAgent('a1')).toMatchObject({ role: 'pilot', state: 'busy', harness: 'claude' });
  expect(upgraded.getAgent('a2')).toMatchObject({ role: 'sentinel', state: 'dead' });
});

test('agents remember their launch details and slots are reused after retirement', () => {
  const a = store.createAgent({ id: 'pilot-aa', role: 'pilot', harness: 'claude', slot: store.allocateSlot() });
  expect(a).toMatchObject({ id: 'pilot-aa', slot: 0, gen: null });
  const b = store.createAgent({ id: 'pilot-bb', role: 'pilot', harness: 'claude', slot: store.allocateSlot() });
  expect(b.slot).toBe(1);
  store.updateAgent(a.id, { gen: 'g1', hookLog: '/x.log', state: 'retired', slot: null });
  expect(store.getAgent(a.id)).toMatchObject({ gen: 'g1', hookLog: '/x.log' });
  expect(store.allocateSlot()).toBe(0);
  store.updateAgent(b.id, { state: 'dead' });
  expect(store.allocateSlot()).toBe(0);
  expect(() => store.createAgent({ role: 'pilot', harness: 'claude', slot: 1 })).toThrow();
  store.updateAgent(b.id, { slot: null });
  expect(store.allocateSlot()).toBe(0);
});

test('the latest review of a task wins', () => {
  const m = store.createMission({ projectId: project().id, type: 'build', goal: 'g', branch: 'b', budget: null });
  const t = store.createTask({ missionId: m.id, title: 't', dependsOn: [] });
  expect(store.latestReview(t.id)).toBeUndefined();
  store.addReview({ missionId: m.id, taskId: t.id, by: 'commander', verdict: 'reject', notes: 'tests missing' });
  store.addReview({ missionId: m.id, taskId: t.id, by: 'commander', verdict: 'approve', notes: 'fixed' });
  expect(store.latestReview(t.id)).toMatchObject({ verdict: 'approve', notes: 'fixed', taskId: t.id });
});
