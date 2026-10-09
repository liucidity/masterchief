import { copyFile, mkdir, rm, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type { CortanaHome } from '@masterchief/core';
import { git } from './git.js';
import { loadRoleConfig, resolveRoleSetting, rolesFile, rulesFile } from './dispatch.js';
import { McError } from './mc-error.js';
import type { Mc } from './mc.js';

const SLUG = /^[a-z0-9][a-z0-9-]{0,30}$/;

export interface SeedOptions {
  /** What this Cortana is responsible for, in plain language. */
  scope: string;
  /** Projects she owns, by id or path in the primary home. */
  projects: string[];
  /** Short name; defaults to a slug of the scope. */
  id?: string;
  harness?: string;
}

/**
 * Cortana is an optional local second mate: a persistent sub-supervisor with a scope, a
 * project list and a home of her own. Her home is a full MasterChief home, so she runs
 * her own crew exactly as the Commander runs his, but she answers to the Commander.
 */
export class Cortana {
  constructor(private mc: Mc) {}

  private get store() {
    return this.mc.d.store;
  }
  private get primaryHome() {
    return this.mc.d.home;
  }
  private homeFor(id: string) {
    return join(this.primaryHome, 'cortana', id);
  }
  private sessionFor(id: string) {
    return `cortana-${id}`;
  }
  private agentId(id: string) {
    return `cortana-${id}`;
  }
  private open(rec: CortanaHome): Mc {
    if (!this.mc.d.openHome) throw new McError('this install cannot open a second mate home');
    return this.mc.d.openHome(rec.homePath, this.sessionFor(rec.id));
  }
  private record(id: string): CortanaHome {
    const rec = this.store.getCortanaHome(id);
    if (!rec) throw new McError(`no such Cortana: ${id} (known: ${this.store.listCortanaHomes().map((c) => c.id).join(', ') || 'none'})`);
    return rec;
  }

  list() {
    return this.store.listCortanaHomes();
  }

  /**
   * Create her home. All or nothing: if any step fails, everything made so far is
   * removed and nothing is recorded. Projects that merge into a local checkout
   * (local-only) stay with the Commander.
   */
  async seed(o: SeedOptions): Promise<CortanaHome> {
    if (!o.scope.trim()) throw new McError('a Cortana needs a scope');
    if (!o.projects.length) throw new McError('a Cortana needs at least one project');
    const id = o.id ?? (o.scope.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 24) || 'cortana');
    if (!SLUG.test(id)) throw new McError(`invalid Cortana id: ${id} (lowercase letters, digits and dashes)`);
    if (this.store.getCortanaHome(id)) throw new McError(`a Cortana named ${id} already exists`);
    const projects = o.projects.map((ref) => this.mc.findProject(ref));
    for (const p of projects) {
      if (p.deliveryMode === 'local-only') throw new McError(`${p.path} is local-only: local-only projects stay with the Commander`);
      if (!p.repoUrl) throw new McError(`${p.path} has no origin remote to clone from`);
    }
    if (o.harness && !this.mc.d.harnessIds?.().includes(o.harness) && this.mc.d.harnessFor) {
      this.mc.d.harnessFor(o.harness); // throws a clear error for an unknown harness
    }

    const home = this.homeFor(id);
    try {
      await mkdir(join(this.primaryHome, 'cortana'), { recursive: true });
      await mkdir(home); // fails if it exists: never adopt a directory we did not make
    } catch (err) {
      throw new McError(`cannot create ${home}: ${(err as Error).message}`);
    }
    try {
      const sub = this.mc.d.openHome ? this.mc.d.openHome(home, this.sessionFor(id)) : undefined;
      if (!sub) throw new McError('this install cannot open a second mate home');
      await mkdir(join(home, 'config'), { recursive: true });
      for (const p of projects) {
        const dest = join(home, 'projects', basename(p.path));
        await mkdir(join(home, 'projects'), { recursive: true });
        await git(home, 'clone', '--quiet', p.repoUrl!, dest).catch((err: Error) => {
          throw new McError(`cloning ${p.repoUrl} failed: ${err.message.split('\n').slice(-2).join(' ').trim()}`);
        });
        await sub.addProject({ path: dest, mode: p.deliveryMode, defaultBranch: p.defaultBranch });
      }
      await this.copyConfig(home);
      await writeFile(join(home, 'charter.md'), `# Charter\n\nScope: ${o.scope}\n\nProjects:\n${projects.map((p) => `- ${p.path}`).join('\n')}\n`);
      await sub.writeCommanderFiles({ role: 'cortana', scope: o.scope, projects: projects.map((p) => join(home, 'projects', basename(p.path))) });
      return this.store.createCortanaHome({ id, scope: o.scope, projects: projects.map((p) => p.id), homePath: home, route: 'local', harness: o.harness ?? null });
    } catch (err) {
      await rm(home, { recursive: true, force: true });
      if (this.store.getCortanaHome(id)) this.store.deleteCortanaHome(id);
      throw err;
    }
  }

  /** Her crew inherits the primary's dispatch rules and role config. */
  private async copyConfig(home: string): Promise<void> {
    for (const [from, to] of [
      [rulesFile(this.primaryHome), rulesFile(home)],
      [rolesFile(this.primaryHome), rolesFile(home)],
    ] as const) {
      await copyFile(from, to).catch((err: NodeJS.ErrnoException) => {
        if (err.code !== 'ENOENT') throw err;
      });
    }
  }

  async start(id: string, o: { fresh?: boolean; trust?: false | { configFile?: string } } = {}) {
    const rec = this.record(id);
    const sub = this.open(rec);
    const cfg = resolveRoleSetting(await loadRoleConfig(this.primaryHome), 'cortana', {});
    const harness = rec.harness ?? cfg.harness;
    const sameHarness = !cfg.harness || cfg.harness === harness;
    const r = await sub.commanderStart({
      harness,
      model: sameHarness ? cfg.model : undefined,
      effort: sameHarness ? cfg.effort : undefined,
      fresh: o.fresh,
      trust: o.trust,
      instructions: { role: 'cortana', scope: rec.scope, projects: rec.projects },
    });
    const inner = sub.d.store.getAgent('commander')!;
    const aid = this.agentId(id);
    if (this.store.getAgent(aid)) {
      this.store.updateAgent(aid, { endpoint: inner.endpoint, gen: inner.gen, hookLog: inner.hookLog, state: r.already ? this.store.getAgent(aid)!.state : 'starting' });
    } else {
      this.store.createAgent({ id: aid, role: 'cortana', harness: inner.harness, model: inner.model, effort: inner.effort, endpoint: inner.endpoint, gen: inner.gen, hookLog: inner.hookLog });
    }
    this.store.addEvent({ missionId: null, agentId: aid, kind: 'cortana-started', payload: { cortana: id } });
    return { cortana: id, agentId: aid, endpoint: inner.endpoint, already: r.already };
  }

  private agent(id: string) {
    this.record(id);
    const a = this.store.getAgent(this.agentId(id));
    if (!a || a.state === 'retired') throw new McError(`${id} is not running (start it with: mc cortana start ${id})`);
    return a;
  }

  /** Route a task or a question to her, as the Commander. */
  async send(id: string, text: string) {
    return this.mc.sendToAgent(this.agent(id), { text });
  }

  /** Her state, the end of her screen, and her crew. */
  async status(id: string, lines = 60) {
    const rec = this.record(id);
    const agent = this.store.getAgent(this.agentId(id));
    if (!agent || agent.state === 'retired' || !agent.endpoint) return { cortana: rec, running: false };
    const sub = this.open(rec);
    return {
      cortana: rec,
      running: true,
      verdict: await this.mc.verdict(agent),
      screen: await this.mc.d.tmux.capture(agent.endpoint, lines).catch(() => ''),
      crew: await sub.fleet(),
    };
  }

  /**
   * Bring her instructions and inherited config up to the primary's version, but only
   * when that cannot disturb anything: she must be idle (or not running) with no crew.
   */
  async sync(id: string) {
    const rec = this.record(id);
    const sub = this.open(rec);
    const crew = await sub.fleet();
    if (crew.length) throw new McError(`not syncing ${id}: ${crew.length} agent(s) are still in flight in her home`);
    const agent = this.store.getAgent(this.agentId(id));
    if (agent && agent.state !== 'retired') {
      const v = await this.mc.verdict(agent);
      if (v.state === 'busy' || v.state === 'unknown') throw new McError(`not syncing ${id}: she is ${v.state}`);
    }
    await this.copyConfig(rec.homePath);
    await sub.writeCommanderFiles({ role: 'cortana', scope: rec.scope, projects: rec.projects });
    return { synced: true, cortana: id };
  }

  /** Stop her. Refuses while her crew has work in flight unless forced. */
  async teardown(id: string, o: { force?: boolean; purge?: boolean } = {}) {
    const rec = this.record(id);
    const sub = this.open(rec);
    const crew = await sub.fleet();
    if (crew.length && !o.force) {
      throw new McError(`refusing to tear down ${id}: ${crew.length} agent(s) in flight (${crew.map((c) => c.agent).join(', ')}). Use --force to discard`);
    }
    for (const c of crew) await sub.teardown(c.agent, { force: true, outcome: 'failed' });
    await sub.stopWatcher().catch(() => undefined);
    await sub.commanderStop().catch(() => undefined);
    const aid = this.agentId(id);
    if (this.store.getAgent(aid)) this.store.updateAgent(aid, { state: 'retired' });
    this.store.deleteCortanaHome(id);
    if (o.purge) await rm(rec.homePath, { recursive: true, force: true });
    this.store.addEvent({ missionId: null, agentId: aid, kind: 'cortana-teardown', payload: { cortana: id, forced: !!o.force, purged: !!o.purge } });
    return { ok: true, cortana: id, purged: !!o.purge };
  }
}
