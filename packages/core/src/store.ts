import type { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import type { Mission, MissionStatus, Project, Task, TaskStatus } from './types.js';

type Row = Record<string, unknown>;

const toProject = (r: Row): Project => ({
  id: r.id as string,
  path: r.path as string,
  defaultBranch: r.default_branch as string,
  repoUrl: r.repo_url as string | null,
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
  agentId: r.agent_id as string | null,
  status: r.status as TaskStatus,
  dependsOn: JSON.parse(r.depends_on as string) as string[],
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

  createProject(p: Omit<Project, 'id'>): Project {
    const id = randomUUID();
    this.db
      .prepare('INSERT INTO project (id, path, default_branch, repo_url) VALUES (?,?,?,?)')
      .run(id, p.path, p.defaultBranch, p.repoUrl);
    return { id, ...p };
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

  createTask(t: Omit<Task, 'id' | 'status' | 'agentId'>): Task {
    const id = randomUUID();
    this.db
      .prepare('INSERT INTO task (id, mission_id, title, agent_id, status, depends_on) VALUES (?,?,?,?,?,?)')
      .run(id, t.missionId, t.title, null, 'pending', JSON.stringify(t.dependsOn));
    return { id, status: 'pending', agentId: null, ...t };
  }

  listTasks(missionId: string): Task[] {
    return this.db.prepare('SELECT * FROM task WHERE mission_id = ?').all(missionId).map(toTask);
  }

  setTaskStatus(id: string, status: TaskStatus): void {
    this.db.prepare('UPDATE task SET status = ? WHERE id = ?').run(status, id);
  }
}
