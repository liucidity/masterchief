import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { Agent, DeliveryMode, Mission, MissionType, Project, Store, Task, TaskKind, Workspace } from '@masterchief/core';
import { classifyAgent, type BusyVerdict } from './busy.js';
import { git } from './git.js';
import { getHarness, type Harness } from './harness.js';
import type { SessionBackend } from './session-backend.js';
import { Watcher, type WatcherOptions } from './watcher.js';
import { agentEnv } from './workspace.js';
import type { WorktreeProvider } from './worktree-provider.js';

/** An error the Commander should read and act on, as opposed to a bug. */
export class McError extends Error {}

export interface McDeps {
  store: Store;
  tmux: SessionBackend;
  worktrees: WorktreeProvider;
  /** MasterChief home: holds the database, per-agent state, and reports. */
  home: string;
  harnessFor?: (id: string) => Harness;
  /** Milliseconds between pasting text and pressing Enter. */
  enterDelayMs?: number;
}

export interface SpawnOptions {
  missionId: string;
  kind: TaskKind;
  title: string;
  harness: string;
  model?: string | null;
  effort?: string | null;
  brief?: string;
  dependsOn?: string[];
  permissionMode?: string;
  /** Skip touching the CLI's trust store. For tests. */
  trust?: false | { configFile?: string };
}

export interface SendOptions {
  text?: string;
  keys?: string[];
  interrupt?: boolean;
  /** Paste text without pressing Enter. */
  noEnter?: boolean;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const TERMINAL_TASK = new Set(['done', 'failed']);

export class Mc {
  constructor(private d: McDeps) {}

  private get store() {
    return this.d.store;
  }
  private harness(id: string): Harness {
    try {
      return (this.d.harnessFor ?? getHarness)(id);
    } catch (e) {
      throw new McError((e as Error).message);
    }
  }
  get stateDir() {
    return join(this.d.home, 'state');
  }
  get dataDir() {
    return join(this.d.home, 'data');
  }

  private resolveId<T extends { id: string }>(kind: string, ref: string, items: T[]): T {
    const exact = items.find((i) => i.id === ref);
    if (exact) return exact;
    const hits = items.filter((i) => i.id.startsWith(ref));
    if (hits.length === 1) return hits[0]!;
    if (hits.length > 1) throw new McError(`ambiguous ${kind} reference: ${ref}`);
    throw new McError(`${kind} not found: ${ref}`);
  }

  /** Only one watcher may run at a time. Returns a function that releases the lock. */
  async acquireWatchLock(): Promise<() => Promise<void>> {
    const file = join(this.d.home, 'watch.pid');
    await mkdir(this.d.home, { recursive: true });
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await writeFile(file, String(process.pid), { flag: 'wx' });
        return () => rm(file, { force: true });
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
        const pid = Number(await readFile(file, 'utf8').catch(() => ''));
        let alive = false;
        if (pid > 0) {
          try {
            process.kill(pid, 0);
            alive = true;
          } catch {
            alive = false;
          }
        }
        if (alive) throw new McError(`a watcher is already running (pid ${pid})`);
        await rm(file, { force: true });
      }
    }
    throw new McError('could not take the watcher lock');
  }

  watcher(opts?: WatcherOptions): Watcher {
    return new Watcher(this, this.d.store, this.d.tmux, opts);
  }

  // ---- projects and missions -------------------------------------------------

  async addProject(opts: { path: string; mode?: DeliveryMode; defaultBranch?: string }): Promise<Project> {
    const path = resolve(opts.path);
    let top: string;
    try {
      top = await git(path, 'rev-parse', '--show-toplevel');
    } catch {
      throw new McError(`not a git repository: ${path}`);
    }
    if (resolve(top) !== path) throw new McError(`not the root of a git repository: ${path} (root is ${top})`);
    const existing = this.store.listProjects().find((p) => p.path === path);
    if (existing) throw new McError(`project already registered: ${existing.id}`);
    const defaultBranch = opts.defaultBranch ?? (await git(path, 'rev-parse', '--abbrev-ref', 'HEAD'));
    const repoUrl = await git(path, 'remote', 'get-url', 'origin').catch(() => null);
    return this.store.createProject({ path, defaultBranch, repoUrl, deliveryMode: opts.mode });
  }

  listProjects(): Project[] {
    return this.store.listProjects();
  }

  findProject(ref: string): Project {
    const byPath = this.store.listProjects().find((p) => p.path === resolve(ref));
    return byPath ?? this.resolveId('project', ref, this.store.listProjects());
  }

  newMission(opts: { project: string; type: MissionType; goal: string }): Mission {
    const project = this.findProject(opts.project);
    if (!opts.goal.trim()) throw new McError('a mission needs a goal');
    const slug = opts.goal.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 24) || 'mission';
    return this.store.createMission({
      projectId: project.id,
      type: opts.type,
      goal: opts.goal,
      branch: `mc/${slug}-${randomBytes(2).toString('hex')}`,
      budget: null,
    });
  }

  findMission(ref: string): Mission {
    return this.resolveId('mission', ref, this.store.listMissions());
  }

  listMissions(): Mission[] {
    return this.store.listMissions();
  }

  showMission(ref: string) {
    const mission = this.findMission(ref);
    return {
      mission,
      tasks: this.store.listTasks(mission.id),
      reviews: this.store.listReviews(mission.id),
      findings: this.store.listFindings(mission.id),
    };
  }

  // ---- spawn -----------------------------------------------------------------

  private newAgentId(role: Agent['role']): string {
    for (;;) {
      const id = `${role}-${randomBytes(2).toString('hex')}`;
      if (!this.store.getAgent(id)) return id;
    }
  }

  private contract(role: 'pilot' | 'sentinel', ws: Workspace, task: Task, mission: Mission): string {
    const common = `You are ${role === 'pilot' ? 'a pilot' : 'a sentinel'} in a MasterChief crew, working for the Commander. Your task id is ${task.id}. Mission goal: ${mission.goal}.`;
    if (role === 'pilot') {
      return `${common} Work only inside ${ws.worktreePath}, on branch ${ws.branch}. Commit your work to that branch. When you finish or get blocked, end your turn with a short plain-text summary of what you did and what is left.`;
    }
    const report = join(this.dataDir, task.id, 'report.md');
    return `${common} This is a read-only investigation: do not modify files in ${ws.worktreePath}. Write your findings to ${report}, with the claim, the evidence and your confidence for each finding. When done, end your turn with a one-paragraph summary.`;
  }

  async spawn(o: SpawnOptions): Promise<{ taskId: string; agentId: string; endpoint: string; worktree: string; branch: string }> {
    const mission = this.findMission(o.missionId);
    if (mission.status === 'done' || mission.status === 'aborted') {
      throw new McError(`mission is ${mission.status}: ${mission.id}`);
    }
    const project = this.store.getProject(mission.projectId)!;
    const harness = this.harness(o.harness);
    const problem = harness.validate(o.model, o.effort);
    if (problem) throw new McError(problem);
    if (!o.title.trim()) throw new McError('a task needs a title');

    const role = o.kind === 'ship' ? 'pilot' : 'sentinel';
    const access = o.kind === 'ship' ? 'rw' : 'ro';
    const agentId = this.newAgentId(role);
    const task = this.store.createTask({ missionId: mission.id, title: o.title, dependsOn: o.dependsOn ?? [], kind: o.kind });

    let ws: Workspace | undefined;
    let endpoint: string | undefined;
    try {
      ws = await this.d.worktrees.acquire({ repoPath: project.path, missionId: mission.id.slice(0, 8), agentId, access });
      this.store.saveWorkspace(ws);
      let slot = this.store.allocateSlot();
      for (let attempt = 0; ; attempt++) {
        try {
          this.store.createAgent({ id: agentId, role, harness: o.harness, model: o.model, effort: o.effort, workspaceId: ws.id, slot });
          break;
        } catch (err) {
          // Another mc process took the slot between allocation and insert.
          if (attempt >= 5 || !/UNIQUE/i.test((err as Error).message)) throw err;
          slot = this.store.allocateSlot();
        }
      }
      this.store.assignTask(task.id, agentId);

      const launch = await harness.prepare({
        agentId,
        role,
        cwd: ws.worktreePath,
        stateDir: this.stateDir,
        model: o.model,
        effort: o.effort,
        permissionMode: o.permissionMode,
        appendSystemPrompt: this.contract(role, ws, task, mission),
        initialPrompt: o.brief,
        trust: o.trust,
      });
      const env = agentEnv(ws, slot);
      await mkdir(env.TMPDIR!, { recursive: true });
      await mkdir(join(this.dataDir, task.id), { recursive: true });
      endpoint = await this.d.tmux.create({
        name: agentId,
        cwd: ws.worktreePath,
        command: launch.command,
        env: { ...env, ...launch.env, MC_HOME: this.d.home, MC_TASK_ID: task.id },
      });
      this.store.updateAgent(agentId, { endpoint, gen: launch.gen, hookLog: launch.hookLog });
      this.store.setTaskStatus(task.id, 'running');
      if (this.store.getMission(mission.id)!.status === 'planning') this.store.setMissionStatus(mission.id, 'running');
      this.store.addEvent({ missionId: mission.id, agentId, kind: 'spawned', payload: { taskId: task.id, role } });
      return { taskId: task.id, agentId, endpoint, worktree: ws.worktreePath, branch: ws.branch };
    } catch (err) {
      if (endpoint) await this.d.tmux.destroy(endpoint).catch(() => undefined);
      if (ws) await this.d.worktrees.release(project.path, ws).catch(() => undefined);
      if (this.store.getAgent(agentId)) this.store.updateAgent(agentId, { state: 'retired', slot: null, workspaceId: null });
      if (ws) this.store.deleteWorkspace(ws.id);
      this.store.setTaskStatus(task.id, 'failed');
      throw err;
    }
  }

  // ---- lookup ----------------------------------------------------------------

  /** A task by id, id prefix, or the id of the agent working on it. */
  findTask(ref: string): Task {
    const all = this.store.listMissions().flatMap((m) => this.store.listTasks(m.id));
    const byAgent = all.find((t) => t.agentId === ref);
    return byAgent ?? this.resolveId('task', ref, all);
  }

  private agentOf(task: Task): Agent {
    const agent = task.agentId ? this.store.getAgent(task.agentId) : undefined;
    if (!agent) throw new McError(`task has no agent: ${task.id}`);
    return agent;
  }

  async verdict(agent: Agent): Promise<BusyVerdict> {
    const endpoint = agent.endpoint ? await this.d.tmux.status(agent.endpoint) : 'missing';
    return classifyAgent({ harness: this.harness(agent.harness), endpoint, hookLog: agent.hookLog, gen: agent.gen });
  }

  // ---- status / send / teardown / events -------------------------------------

  async status(ref?: string, opts: { lines?: number } = {}) {
    if (ref) {
      const task = this.findTask(ref);
      const agent = this.agentOf(task);
      const verdict = await this.verdict(agent);
      const screen = agent.endpoint && agent.state !== 'retired' ? await this.d.tmux.capture(agent.endpoint, opts.lines ?? 60).catch(() => '') : '';
      return { task, agent, verdict, screen };
    }
    const rows = [];
    for (const m of this.store.listMissions()) {
      for (const task of this.store.listTasks(m.id)) {
        const agent = task.agentId ? this.store.getAgent(task.agentId) : undefined;
        if (!agent || agent.state === 'retired') continue;
        rows.push({ mission: m.id, task: task.id, title: task.title, kind: task.kind, status: task.status, agent: agent.id, harness: agent.harness, verdict: await this.verdict(agent) });
      }
    }
    return rows;
  }

  async send(ref: string, o: SendOptions): Promise<{ ok: true }> {
    const task = this.findTask(ref);
    const agent = this.agentOf(task);
    if (!agent.endpoint || agent.state === 'retired') throw new McError(`agent is not running: ${agent.id}`);
    const status = await this.d.tmux.status(agent.endpoint);
    if (status !== 'alive') throw new McError(`agent endpoint is ${status}: ${agent.id}`);
    if (o.text === undefined && !o.keys?.length && !o.interrupt) throw new McError('nothing to send');
    if (o.interrupt) await this.d.tmux.sendKeys(agent.endpoint, ...this.harness(agent.harness).interruptKeys);
    if (o.keys?.length) await this.d.tmux.sendKeys(agent.endpoint, ...o.keys);
    if (o.text !== undefined) {
      await this.d.tmux.sendText(agent.endpoint, o.text);
      if (!o.noEnter) {
        await sleep(this.d.enterDelayMs ?? 150);
        await this.d.tmux.sendKeys(agent.endpoint, 'Enter');
      }
    }
    return { ok: true };
  }

  /** Reasons a worktree still holds work that would be lost by removing it. */
  async unlandedWork(project: Project, ws: Workspace): Promise<string[]> {
    const reasons: string[] = [];
    const dirty = await git(ws.worktreePath, 'status', '--porcelain').catch(() => '');
    if (dirty) reasons.push(`uncommitted changes (${dirty.split('\n').length} paths)`);
    if (ws.branch) {
      const base = await git(project.path, 'rev-parse', '--verify', '--quiet', `refs/heads/${project.defaultBranch}`).then(
        () => project.defaultBranch,
        () => 'HEAD',
      );
      const ahead = await git(project.path, 'rev-list', '--count', `${base}..${ws.branch}`).catch(() => '0');
      if (Number(ahead) > 0) reasons.push(`${ahead} commit(s) on ${ws.branch} not in ${base}`);
    }
    return reasons;
  }

  async teardown(ref: string, o: { force?: boolean; outcome?: 'done' | 'failed' } = {}) {
    const task = this.findTask(ref);
    const agent = this.agentOf(task);
    if (agent.state === 'retired') throw new McError(`already torn down: ${agent.id}`);
    const mission = this.store.getMission(task.missionId)!;
    const project = this.store.getProject(mission.projectId)!;
    const ws = agent.workspaceId ? this.store.getWorkspace(agent.workspaceId) : undefined;
    if (ws && !o.force) {
      const reasons = await this.unlandedWork(project, ws);
      if (reasons.length) throw new McError(`refusing to tear down ${agent.id}: ${reasons.join('; ')} (use --force to discard)`);
    }
    if (agent.endpoint) await this.d.tmux.destroy(agent.endpoint);
    if (ws) {
      await this.d.worktrees.release(project.path, ws);
      this.store.updateAgent(agent.id, { workspaceId: null });
      this.store.deleteWorkspace(ws.id);
    }
    this.store.updateAgent(agent.id, { state: 'retired', slot: null });
    if (!TERMINAL_TASK.has(task.status)) this.store.setTaskStatus(task.id, o.outcome ?? 'done');
    this.store.addEvent({ missionId: mission.id, agentId: agent.id, kind: 'teardown', payload: { taskId: task.id, forced: !!o.force } });
    return { ok: true, agent: agent.id };
  }

  /** New events since the last read. Reading advances the cursor unless `peek` is set. */
  events(o: { after?: number; peek?: boolean; mission?: string } = {}) {
    const cursor = o.after ?? Number(this.store.getSetting('events_cursor') ?? 0);
    const events = this.store.listEvents({ afterSeq: cursor, missionId: o.mission ? this.findMission(o.mission).id : undefined });
    if (!o.peek && o.after === undefined && events.length) {
      this.store.setSetting('events_cursor', String(events[events.length - 1]!.seq));
    }
    return events;
  }

  async readBrief(arg: string): Promise<string> {
    return arg.startsWith('@') ? readFile(arg.slice(1), 'utf8') : arg;
  }
}
