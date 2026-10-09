import { execFile, spawn as spawnProcess } from 'node:child_process';
import { promisify } from 'node:util';
import { randomBytes } from 'node:crypto';
import { chmod, open as openFile } from 'node:fs/promises';
import { appendFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { Agent, DeliveryMode, Mission, MissionType, Project, Store, Task, TaskKind, Workspace } from '@masterchief/core';
import { classifyAgent, type BusyVerdict } from './busy.js';
import { McError } from './mc-error.js';
import { commanderInstructions } from './commander-instructions.js';
import { loadRoleConfig, readRules, resolveRoleSetting, rolesFile, rulesFile, STARTER_RULES, type ConfigKey } from './dispatch.js';
import { git } from './git.js';
import { getHarness, listHarnesses, type Harness } from './harness.js';
import type { SessionBackend } from './session-backend.js';
import { Afk } from './afk.js';
import { Cortana } from './cortana.js';
import { Watcher, type WatcherOptions } from './watcher.js';
import { agentEnv } from './workspace.js';
import type { WorktreeProvider } from './worktree-provider.js';

export { McError };

export interface McDeps {
  store: Store;
  tmux: SessionBackend;
  worktrees: WorktreeProvider;
  /** MasterChief home: holds the database, per-agent state, and reports. */
  home: string;
  harnessFor?: (id: string) => Harness;
  /** Harness ids offered to the Commander. Defaults to every registered harness. */
  harnessIds?: () => string[];
  /** Milliseconds between pasting text and pressing Enter. */
  enterDelayMs?: number;
  /** Opens another MasterChief home, for a second mate. The session names the tmux session its windows go in. */
  openHome?: (home: string, session: string) => Mc;
  /** Path to the compiled mc entrypoint, used for the Commander's mc shim and the background watcher. */
  cliPath?: string;
  /** Path to the compiled guard entrypoint. Crew members run it before every tool call. */
  guardPath?: string;
  /** GitHub CLI used to open pull requests. Defaults to gh. */
  ghCommand?: string;
  /** Extra environment for every agent, such as the tmux socket name. */
  extraEnv?: Record<string, string>;
}

export interface SpawnOptions {
  missionId: string;
  kind: TaskKind;
  title: string;
  /** Omit to use the configured harness for the role. Refused when dispatch rules exist, so the Commander chooses. */
  harness?: string;
  model?: string | null;
  effort?: string | null;
  /** Use the small-model settings for short, high-volume work. */
  tier?: 'small';
  brief?: string;
  dependsOn?: string[];
  permissionMode?: string;
  /** Skip touching the CLI's trust store. For tests. */
  trust?: false | { configFile?: string };
}

export interface SendOptions {
  text?: string;
  /** Type even if the agent is waiting at a prompt or its input box holds a draft. */
  force?: boolean;
  keys?: string[];
  interrupt?: boolean;
  /** Paste text without pressing Enter. */
  noEnter?: boolean;
}

const run = promisify(execFile);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const TERMINAL_TASK = new Set(['done', 'failed']);

export class Mc {
  constructor(readonly d: McDeps) {}

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
    return this.acquireLock('watch.pid', 'a watcher');
  }

  /** Take a single-instance lock file in the home. Replaces the lock of a dead process. */
  async acquireLock(name: string, what: string): Promise<() => Promise<void>> {
    const file = join(this.d.home, name);
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
        if (alive) throw new McError(`${what} is already running (pid ${pid})`);
        await rm(file, { force: true });
      }
    }
    throw new McError(`could not take the ${name} lock`);
  }

  /** Optional away mode. */
  get afk(): Afk {
    return (this._afk ??= new Afk(this));
  }
  private _afk?: Afk;

  /** Second mates: persistent sub-supervisors with their own homes. */
  get cortana(): Cortana {
    return (this._cortana ??= new Cortana(this));
  }
  private _cortana?: Cortana;

  watcher(opts?: WatcherOptions): Watcher {
    return new Watcher(this, this.d.store, this.d.tmux, opts);
  }

  // ---- commander and background watcher --------------------------------------

  get commanderDir() {
    return join(this.d.home, 'commander');
  }

  private findCommander(): Agent | undefined {
    return this.store.listAgents().find((a) => a.role === 'commander');
  }

  /** Write a small `mc` script the Commander's shell can run, without a global install. */
  private async writeShim(): Promise<string | undefined> {
    if (!this.d.cliPath) return undefined;
    for (const p of [this.d.cliPath, process.execPath]) {
      if (p.includes("'")) throw new McError(`unsafe path for the mc shim: ${p}`);
    }
    const dir = join(this.d.home, 'bin');
    await mkdir(dir, { recursive: true });
    const file = join(dir, 'mc');
    await writeFile(file, `#!/bin/sh\nexec '${process.execPath}' --disable-warning=ExperimentalWarning '${this.d.cliPath}' "$@"\n`);
    await chmod(file, 0o755);
    return dir;
  }

  /** Write the Commander's instructions and mc shim. Safe to repeat. Returns the shim directory. */
  async writeCommanderFiles(instructions: { role?: 'commander' | 'cortana'; scope?: string; projects?: string[] } = {}): Promise<string | undefined> {
    await mkdir(this.commanderDir, { recursive: true });
    await writeFile(join(this.commanderDir, 'CLAUDE.md'), commanderInstructions({ home: this.d.home, ...instructions }));
    await mkdir(join(this.d.home, 'config'), { recursive: true });
    return this.writeShim();
  }

  async commanderStart(o: { harness?: string; model?: string | null; effort?: string | null; fresh?: boolean; trust?: false | { configFile?: string }; instructions?: { role?: 'commander' | 'cortana'; scope?: string; projects?: string[] } } = {}) {
    const cfg = resolveRoleSetting(await loadRoleConfig(this.d.home), 'commander', {});
    const harnessId = o.harness ?? cfg.harness ?? 'claude';
    const sameHarness = !cfg.harness || cfg.harness === harnessId;
    const model = o.model ?? (sameHarness ? cfg.model : undefined);
    const effort = o.effort ?? (sameHarness ? cfg.effort : undefined);
    const harness = this.harness(harnessId);
    const problem = harness.validate(model, effort);
    if (problem) throw new McError(problem);

    const existing = this.findCommander();
    if (existing && existing.state !== 'retired' && existing.endpoint) {
      if ((await this.d.tmux.status(existing.endpoint)) === 'alive') {
        await this.ensureWatcherBackground();
        return { agentId: existing.id, endpoint: existing.endpoint, already: true };
      }
      await this.d.tmux.destroy(existing.endpoint);
    }

    await mkdir(this.commanderDir, { recursive: true });
    const binDir = await this.writeCommanderFiles(o.instructions);

    const resume = !!existing && !o.fresh;
    const launch = await harness.prepare({
      agentId: 'commander',
      role: 'commander',
      cwd: this.commanderDir,
      stateDir: this.stateDir,
      model,
      effort,
      permissionMode: 'default',
      allowTools: ['Bash(mc *)', 'Bash(git diff *)', 'Bash(git log *)', 'Bash(git status*)', 'Bash(git -C * diff *)', 'Bash(git -C * log *)', 'Bash(git -C * status*)', 'Read', 'Glob', 'Grep'],
      denyTools: ['Edit', 'Write', 'NotebookEdit'],
      resume,
      initialPrompt:
        o.instructions?.role === 'cortana'
          ? 'Session start. Follow the Session start section of your instructions. Do not begin new work until the Commander routes some to you.'
          : 'Session start. Follow the Session start section of your instructions.',
      trust: o.trust,
    });
    const endpoint = await this.d.tmux.create({
      name: 'commander',
      cwd: this.commanderDir,
      command: launch.command,
      env: {
        ...launch.env,
        ...this.d.extraEnv,
        MC_HOME: this.d.home,
        ...(binDir ? { PATH: `${binDir}:${process.env.PATH ?? ''}` } : {}),
      },
    });
    if (existing) {
      this.store.updateAgent(existing.id, { endpoint, gen: launch.gen, hookLog: launch.hookLog, state: 'starting' });
    } else {
      this.store.createAgent({ id: 'commander', role: 'commander', harness: harnessId, model, effort, endpoint, gen: launch.gen, hookLog: launch.hookLog });
    }
    this.store.addEvent({ missionId: null, agentId: 'commander', kind: 'commander-started', payload: { resumed: resume } });
    await this.ensureWatcherBackground();
    return { agentId: 'commander', endpoint, already: false, resumed: resume };
  }

  async commanderStop() {
    const c = this.findCommander();
    if (!c || c.state === 'retired') throw new McError('no commander is running');
    if (c.endpoint) await this.d.tmux.destroy(c.endpoint);
    this.store.updateAgent(c.id, { state: 'retired' });
    return { ok: true };
  }

  async commanderStatus() {
    const c = this.findCommander();
    return c && c.state !== 'retired' ? { agent: c, verdict: await this.verdict(c) } : { agent: null, verdict: null };
  }

  /** Command line that attaches the human's terminal to the Commander. */
  attachCommand(): string[] {
    const c = this.findCommander();
    if (!c || c.state === 'retired' || !c.endpoint) throw new McError('no commander is running (start it with: mc commander start)');
    if (!this.d.tmux.attachCommand) throw new McError('this session backend cannot be attached to');
    return this.d.tmux.attachCommand(c.endpoint);
  }

  async watchStatus(): Promise<{ running: boolean; pid?: number }> {
    return this.lockStatus('watch.pid');
  }

  async lockStatus(name: string): Promise<{ running: boolean; pid?: number }> {
    const pid = Number(await readFile(join(this.d.home, name), 'utf8').catch(() => ''));
    if (pid > 0) {
      try {
        process.kill(pid, 0);
        return { running: true, pid };
      } catch {
        /* stale */
      }
    }
    return { running: false };
  }

  /** Start the watcher as a detached process if none is running. */
  async ensureWatcherBackground(): Promise<{ running: boolean; pid?: number; started: boolean }> {
    const now = await this.watchStatus();
    if (now.running) return { ...now, started: false };
    if (!this.d.cliPath) return { running: false, started: false };
    await mkdir(this.d.home, { recursive: true });
    const log = await openFile(join(this.d.home, 'watch.log'), 'a');
    const child = spawnProcess(process.execPath, ['--disable-warning=ExperimentalWarning', this.d.cliPath, 'watch'], {
      detached: true,
      stdio: ['ignore', log.fd, log.fd],
      env: { ...process.env, MC_HOME: this.d.home, ...this.d.extraEnv },
    });
    child.unref();
    await log.close();
    for (let i = 0; i < 40; i++) {
      await sleep(50);
      const s = await this.watchStatus();
      if (s.running) return { ...s, started: true };
    }
    throw new McError(`the watcher did not start; see ${join(this.d.home, 'watch.log')}`);
  }

  async stopWatcher(): Promise<{ stopped: boolean }> {
    const s = await this.watchStatus();
    if (!s.running) return { stopped: false };
    process.kill(s.pid!, 'SIGTERM');
    for (let i = 0; i < 60; i++) {
      await sleep(50);
      if (!(await this.watchStatus()).running) return { stopped: true };
    }
    throw new McError(`watcher ${s.pid} did not stop`);
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

  /**
   * Pick the concrete harness, model and effort. Explicit values win. Without a
   * harness, dispatch rules force the Commander to choose; otherwise the configured
   * one is used. Configured model and effort apply only to the configured harness.
   */
  private async chooseLaunch(
    role: ConfigKey,
    o: { harness?: string; model?: string | null; effort?: string | null; tier?: 'small' },
    mission: Mission,
    project: Project,
  ) {
    const cfg = resolveRoleSetting(await loadRoleConfig(this.d.home), role, {
      missionId: mission.id,
      projectId: project.id,
      projectPath: project.path,
      tier: o.tier,
    });
    let harnessId = o.harness;
    if (!harnessId) {
      if ((await readRules(this.d.home)).active) {
        throw new McError(`dispatch rules exist (${rulesFile(this.d.home)}): choose a harness, model and effort from them and pass --harness`);
      }
      harnessId = cfg.harness;
    }
    if (!harnessId) throw new McError(`no harness: pass --harness or set one for "${role}" in ${rolesFile(this.d.home)}`);
    const sameHarness = !cfg.harness || cfg.harness === harnessId;
    return {
      harnessId,
      model: o.model ?? (sameHarness ? cfg.model ?? null : null),
      effort: o.effort ?? (sameHarness ? cfg.effort ?? null : null),
    };
  }

  /** The captain's dispatch rules, the harnesses available, and the configured defaults. */
  async dispatchInfo() {
    const rules = await readRules(this.d.home);
    return {
      rulesFile: rules.file,
      rules: rules.active ? rules.text : null,
      rolesFile: rolesFile(this.d.home),
      roleConfig: await loadRoleConfig(this.d.home),
      harnesses: (this.d.harnessIds ?? listHarnesses)().map((id) => ({ id, efforts: this.harness(id).efforts })),
    };
  }

  async dispatchInit(): Promise<{ created: boolean; file: string }> {
    const file = rulesFile(this.d.home);
    await mkdir(join(this.d.home, 'config'), { recursive: true });
    try {
      await writeFile(file, STARTER_RULES, { flag: 'wx' });
      return { created: true, file };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') return { created: false, file };
      throw err;
    }
  }

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
    if (!o.title.trim()) throw new McError('a task needs a title');
    const role = o.kind === 'ship' ? 'pilot' : 'sentinel';
    const { harnessId, model, effort } = await this.chooseLaunch(role, o, mission, project);
    const harness = this.harness(harnessId);
    const problem = harness.validate(model, effort);
    if (problem) throw new McError(problem);

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
          this.store.createAgent({ id: agentId, role, harness: harnessId, model, effort, workspaceId: ws.id, slot });
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
        model,
        effort,
        permissionMode: o.permissionMode,
        appendSystemPrompt: this.contract(role, ws, task, mission),
        initialPrompt: o.brief,
        guardCommand: this.d.guardPath
          ? [
              process.execPath,
              '--disable-warning=ExperimentalWarning',
              this.d.guardPath,
              '--role',
              role,
              '--worktree',
              ws.worktreePath,
              ...(role === 'sentinel' ? ['--report-dir', join(this.dataDir, task.id)] : []),
            ]
          : undefined,
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

  /** Live agents with a task, in every mission. */
  async fleet() {
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

  /** One task in detail: its agent, live verdict, and the end of its screen. */
  async taskStatus(ref: string, opts: { lines?: number } = {}) {
    const task = this.findTask(ref);
    const agent = this.agentOf(task);
    const verdict = await this.verdict(agent);
    const screen = agent.endpoint && agent.state !== 'retired' ? await this.d.tmux.capture(agent.endpoint, opts.lines ?? 60).catch(() => '') : '';
    return { task, agent, verdict, screen };
  }

  async status(): Promise<Awaited<ReturnType<Mc['fleet']>>>;
  async status(ref: string, opts?: { lines?: number }): Promise<Awaited<ReturnType<Mc['taskStatus']>>>;
  async status(ref?: string, opts: { lines?: number } = {}) {
    return ref ? this.taskStatus(ref, opts) : this.fleet();
  }

  async send(ref: string, o: SendOptions): Promise<{ ok: true }> {
    return this.sendToAgent(this.agentOf(this.findTask(ref)), o);
  }

  /**
   * Typing and pressing Enter into a permission prompt would answer it, and into a draft would
   * corrupt it. So text goes in only when the agent is not waiting and its input box is empty.
   */
  async requireReadyToType(agent: Agent): Promise<void> {
    if (!agent.endpoint) throw new McError(`agent is not running: ${agent.id}`);
    const verdict = await this.verdict(agent);
    if (verdict.state === 'waiting') {
      throw new McError(`${agent.id} is waiting at a prompt, and typing would answer it. Read its screen with mc status, or use --force`);
    }
    const harness = this.harness(agent.harness);
    if (!harness.composerState) return;
    const state = harness.composerState(await this.d.tmux.capture(agent.endpoint, 25));
    if (state !== 'empty') {
      throw new McError(`${agent.id}'s input box is ${state === 'typing' ? 'not empty (someone is typing or a dialog is open)' : 'not readable'}, so nothing was typed. Try again shortly, or use --force`);
    }
  }

  /** Type into a running agent's terminal. */
  async sendToAgent(agent: Agent, o: SendOptions): Promise<{ ok: true }> {
    if (!agent.endpoint || agent.state === 'retired') throw new McError(`agent is not running: ${agent.id}`);
    const status = await this.d.tmux.status(agent.endpoint);
    if (status !== 'alive') throw new McError(`agent endpoint is ${status}: ${agent.id}`);
    if (o.text === undefined && !o.keys?.length && !o.interrupt) throw new McError('nothing to send');
    if (o.text !== undefined && !o.force) await this.requireReadyToType(agent);
    if (o.interrupt) await this.d.tmux.sendKeys(agent.endpoint, ...this.harness(agent.harness).interruptKeys);
    if (o.keys?.length) await this.d.tmux.sendKeys(agent.endpoint, ...o.keys);
    if (o.text !== undefined) {
      const harness = this.harness(agent.harness);
      if (harness.recordsSends && agent.hookLog && agent.gen) {
        await appendFile(agent.hookLog, `${agent.gen} ${Math.floor(Date.now() / 1000)} prompt\n`);
      }
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
      if (Number(ahead) > 0) {
        // Work that is safely on the remote is not lost by removing the worktree.
        const pushed = await git(project.path, 'merge-base', '--is-ancestor', ws.branch, `origin/${ws.branch}`).then(
          () => true,
          () => false,
        );
        if (!pushed) reasons.push(`${ahead} commit(s) on ${ws.branch} not in ${base} and not pushed`);
      }
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

  // ---- review, landing and finishing -----------------------------------------

  /** Record the Commander's verdict on a pilot's work. Landing requires an approving verdict. */
  review(ref: string, o: { verdict: 'approve' | 'reject' | 'escalate'; notes: string }) {
    const task = this.findTask(ref);
    if (task.kind !== 'ship') throw new McError('only ship tasks are reviewed; record sentinel conclusions with mc finding');
    if (!o.notes.trim()) throw new McError('a review needs notes saying why');
    return this.store.addReview({ missionId: task.missionId, taskId: task.id, by: 'commander', verdict: o.verdict, notes: o.notes });
  }

  /** Deliver a pilot's branch according to its task's delivery mode. */
  async land(ref: string, o: { title?: string; body?: string } = {}) {
    const task = this.findTask(ref);
    if (task.kind !== 'ship') throw new McError('only ship tasks can be landed');
    const agent = this.agentOf(task);
    const ws = agent.workspaceId ? this.store.getWorkspace(agent.workspaceId) : undefined;
    if (!ws || agent.state === 'retired') throw new McError(`nothing to land: ${agent.id} has no worktree`);
    const mission = this.store.getMission(task.missionId)!;
    const project = this.store.getProject(mission.projectId)!;
    const base = project.defaultBranch;

    if (await git(ws.worktreePath, 'status', '--porcelain')) {
      throw new McError(`${agent.id} has uncommitted changes: ask it to commit first`);
    }
    const ahead = Number(await git(project.path, 'rev-list', '--count', `${base}..${ws.branch}`));
    if (ahead === 0) throw new McError(`nothing to land: ${ws.branch} has no commits beyond ${base}`);
    const verdict = this.store.latestReview(task.id);
    if (verdict?.verdict !== 'approve') {
      throw new McError(`review required before landing: run mc review ${agent.id} --verdict approve --notes <why> (latest verdict: ${verdict?.verdict ?? 'none'})`);
    }

    if (task.deliveryMode === 'local-only') {
      const current = await git(project.path, 'rev-parse', '--abbrev-ref', 'HEAD');
      if (current !== base) throw new McError(`the project checkout is on ${current}, not ${base}: the captain must switch it before a local landing`);
      if (await git(project.path, 'status', '--porcelain', '--untracked-files=no')) {
        throw new McError('the project checkout has uncommitted changes: the captain must clean it before a local landing');
      }
      try {
        await git(project.path, 'merge', '--ff-only', ws.branch);
      } catch {
        throw new McError(`cannot fast-forward ${base} to ${ws.branch}: ${base} has moved. Ask the pilot to rebase onto ${base} and run the tests again`);
      }
      const sha = await git(project.path, 'rev-parse', 'HEAD');
      this.store.addEvent({ missionId: mission.id, agentId: agent.id, kind: 'landed', payload: { taskId: task.id, mode: 'local-only', sha } });
      return { mode: 'local-only', branch: ws.branch, merged: true, sha };
    }

    if (!(await git(project.path, 'remote', 'get-url', 'origin').catch(() => ''))) {
      throw new McError(`${project.path} has no origin remote, so a pull request cannot be opened`);
    }
    await git(ws.worktreePath, 'push', '-u', 'origin', ws.branch).catch((err: Error) => {
      throw new McError(`push failed: ${err.message.split('\n').slice(-2).join(' ').trim()}`);
    });
    const title = o.title ?? task.title;
    const body = o.body ?? `${mission.goal}\n\nTask: ${task.title}\n\nOpened by MasterChief (${agent.id}).`;
    let pr: string;
    try {
      const { stdout } = await run(this.d.ghCommand ?? 'gh', ['pr', 'create', '--base', base, '--head', ws.branch, '--title', title, '--body', body], { cwd: ws.worktreePath });
      pr = stdout.trim();
    } catch (err) {
      throw new McError(`the branch was pushed, but opening the pull request failed: ${String((err as Error).message).split('\n')[0]}`);
    }
    this.store.addEvent({ missionId: mission.id, agentId: agent.id, kind: 'landed', payload: { taskId: task.id, mode: task.deliveryMode, pr } });
    return { mode: task.deliveryMode, branch: ws.branch, pushed: true, pr };
  }

  /** Record what held up from an investigation. */
  addFinding(o: { mission: string; claim: string; evidence: string; confidence: number }) {
    const mission = this.findMission(o.mission);
    if (!o.claim.trim() || !o.evidence.trim()) throw new McError('a finding needs a claim and evidence');
    if (!Number.isFinite(o.confidence) || o.confidence < 0 || o.confidence > 1) throw new McError('confidence must be a number from 0 to 1');
    return this.store.addFinding({ missionId: mission.id, claim: o.claim, evidence: o.evidence, confidence: o.confidence });
  }

  listFindings(missionRef: string) {
    return this.store.listFindings(this.findMission(missionRef).id);
  }

  /** Close out a mission once nothing in it is running. */
  finishMission(ref: string, o: { abort?: boolean } = {}): Mission {
    const mission = this.findMission(ref);
    const live = this.store
      .listTasks(mission.id)
      .map((t) => (t.agentId ? this.store.getAgent(t.agentId) : undefined))
      .filter((a): a is Agent => !!a && a.state !== 'retired');
    if (live.length) throw new McError(`mission still has live agents: ${live.map((a) => a.id).join(', ')} (tear them down first)`);
    const next = o.abort ? 'aborted' : 'done';
    if (!o.abort) {
      const open = this.store.listTasks(mission.id).filter((t) => !TERMINAL_TASK.has(t.status));
      if (open.length) throw new McError(`mission has unfinished tasks: ${open.map((t) => t.id.slice(0, 8)).join(', ')} (or finish with --abort)`);
    }
    this.store.setMissionStatus(mission.id, next);
    return this.store.getMission(mission.id)!;
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
