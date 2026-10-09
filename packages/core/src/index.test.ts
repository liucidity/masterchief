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
