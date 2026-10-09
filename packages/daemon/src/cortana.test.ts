import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, Store } from '@masterchief/core';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { fakeHarness } from './fake-harness.js';
import { Mc } from './mc.js';
import { TmuxBackend } from './tmux.js';
import { freshWorktrees } from './worktree-provider.js';

let root: string;
let repo: string;
let origin: string;
let home: string;
let store: Store;
let socket: string;
let tmux: TmuxBackend;
let mc: Mc;
const git = (cwd: string, ...a: string[]) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { cwd, encoding: 'utf8' }).trim();

const waitFor = async (fn: () => Promise<boolean> | boolean, ms = 8000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('timed out');
};

const build = (h: string, session: string): Mc =>
  new Mc({
    store: new Store(openDb(h === home ? undefined : join(h, 'mc.db'))),
    tmux: new TmuxBackend({ socket, session }),
    worktrees: freshWorktrees,
    home: h,
    enterDelayMs: 20,
    harnessIds: () => ['fake'],
    harnessFor: () => fakeHarness,
    openHome: (path, s) => (mkdir(path, { recursive: true }), build(path, s)),
  });

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'mc-cort-')));
  repo = join(root, 'repo');
  origin = join(root, 'origin.git');
  home = join(root, 'home');
  await mkdir(repo);
  await mkdir(home);
  git(root, 'init', '-q', '--bare', '-b', 'main', origin);
  git(repo, 'init', '-q', '-b', 'main');
  await writeFile(join(repo, 'a.txt'), 'a');
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'init');
  git(repo, 'remote', 'add', 'origin', origin);
  git(repo, 'push', '-q', 'origin', 'main');
  socket = `mc-cort-${process.pid}-${Date.now()}`;
  tmux = new TmuxBackend({ socket });
  mc = new Mc({
    store: (store = new Store(openDb())),
    tmux,
    worktrees: freshWorktrees,
    home,
    enterDelayMs: 20,
    harnessIds: () => ['fake'],
    harnessFor: () => fakeHarness,
    openHome: (path, s) => (mkdir(path, { recursive: true }), build(path, s)),
  });
  await mkdir(join(home, 'config'), { recursive: true });
  await writeFile(join(home, 'config', 'roles.json'), JSON.stringify({ global: { pilot: { harness: 'fake' }, cortana: { harness: 'fake' } } }));
});
afterEach(async () => {
  await tmux.killServer();
  await rm(root, { recursive: true, force: true });
});

const project = async () => store.listProjects().find((p) => p.path === repo) ?? (await mc.addProject({ path: repo, mode: 'direct-pr' }));
const seed = async (extra = {}) => {
  const p = await project();
  return mc.cortana.seed({ scope: 'issue triage and bug fixes', projects: [p.id], id: 'triage', ...extra });
};

test('seeding builds a home with her own clone, database, charter and instructions', async () => {
  const rec = await seed();
  expect(rec).toMatchObject({ id: 'triage', route: 'local', scope: 'issue triage and bug fixes', homePath: join(home, 'cortana', 'triage') });
  expect(store.getCortanaHome('triage')).toEqual(rec);
  const clone = join(rec.homePath, 'projects', 'repo');
  expect(git(clone, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('main');
  expect(git(clone, 'remote', 'get-url', 'origin')).toBe(origin);
  expect(readFileSync(join(rec.homePath, 'charter.md'), 'utf8')).toContain('issue triage and bug fixes');
  const instructions = readFileSync(join(rec.homePath, 'commander', 'CLAUDE.md'), 'utf8');
  expect(instructions).toContain('# MasterChief Cortana (second mate)');
  expect(instructions).toContain('You answer to the Commander');
  expect(instructions).toContain('You are idle by default');
  expect(instructions).toContain('Never ask the captain directly');
  expect(instructions).not.toContain('tell the captain');
  expect(instructions).not.toContain('give the captain');
  expect(instructions.match(/captain/g)).toHaveLength(3);
  expect(existsSync(join(rec.homePath, 'config', 'roles.json'))).toBe(true);
  const herDb = new Store(openDb(join(rec.homePath, 'mc.db')));
  expect(herDb.listProjects()).toMatchObject([{ path: clone, deliveryMode: 'direct-pr' }]);
  expect(mc.cortana.list()).toHaveLength(1);
});

test('seeding refuses bad input before creating anything', async () => {
  const p = await project();
  await expect(mc.cortana.seed({ scope: ' ', projects: [p.id] })).rejects.toThrow(/needs a scope/);
  await expect(mc.cortana.seed({ scope: 's', projects: [] })).rejects.toThrow(/at least one project/);
  await expect(mc.cortana.seed({ scope: 's', projects: [p.id], id: 'Bad Id' })).rejects.toThrow(/invalid Cortana id/);
  await expect(mc.cortana.seed({ scope: 's', projects: ['nope'] })).rejects.toThrow(/project not found/);
  store.createProject({ path: '/some/local', defaultBranch: 'main', repoUrl: null, deliveryMode: 'local-only' });
  store.createProject({ path: '/some/noremote', defaultBranch: 'main', repoUrl: null });
  await expect(mc.cortana.seed({ scope: 's', projects: ['/some/local'] })).rejects.toThrow(/local-only projects stay with the Commander/);
  await expect(mc.cortana.seed({ scope: 's', projects: ['/some/noremote'] })).rejects.toThrow(/no origin remote/);
  expect(existsSync(join(home, 'cortana', 's'))).toBe(false);
  await seed();
  await expect(seed()).rejects.toThrow(/already exists/);
});

test('a seed that fails part way rolls back completely', async () => {
  const p = await project();
  const broken = store.createProject({ path: join(root, 'ghost'), defaultBranch: 'main', repoUrl: join(root, 'does-not-exist.git'), deliveryMode: 'direct-pr' });
  await expect(mc.cortana.seed({ scope: 'two projects', projects: [p.id, broken.id], id: 'half' })).rejects.toThrow(/cloning .* failed/);
  expect(existsSync(join(home, 'cortana', 'half'))).toBe(false);
  expect(store.getCortanaHome('half')).toBeUndefined();
  expect(store.listCortanaHomes()).toEqual([]);
  // The id is free again.
  expect(await mc.cortana.seed({ scope: 'two projects', projects: [p.id], id: 'half' })).toBeTruthy();
});

test('starting launches her session, is idempotent, and the primary watcher tracks her', async () => {
  await seed();
  const r = await mc.cortana.start('triage', { trust: false });
  expect(r).toMatchObject({ cortana: 'triage', agentId: 'cortana-triage', already: false });
  expect(store.getAgent('cortana-triage')).toMatchObject({ role: 'cortana', permanent: true });
  await waitFor(async () => (await mc.cortana.status('triage')).screen?.includes('got: Session start') ?? false);
  const again = await mc.cortana.start('triage', { trust: false });
  expect(again).toMatchObject({ already: true, endpoint: r.endpoint });

  const w = mc.watcher();
  await waitFor(async () => (await mc.verdict(store.getAgent('cortana-triage')!)).state === 'idle');
  const events = await w.tick();
  expect(events.map((e) => [e.kind, e.agentId])).toContainEqual(['finished', 'cortana-triage']);
  await mc.cortana.teardown('triage', { force: true });
});

test('the Commander can route text to her and read her crew', async () => {
  const rec = await seed();
  await mc.cortana.start('triage', { trust: false });
  await waitFor(async () => (await mc.verdict(store.getAgent('cortana-triage')!)).state === 'idle');
  await mc.cortana.send('triage', 'triage issue 12');
  await waitFor(async () => (await mc.cortana.status('triage')).screen?.includes('got: triage issue 12') ?? false);

  const her = build(rec.homePath, 'cortana-triage');
  const p = her.listProjects()[0]!;
  const m = her.newMission({ project: p.id, type: 'build', goal: 'fix issue 12' });
  await her.spawn({ missionId: m.id, kind: 'ship', title: 'fix', harness: 'fake', trust: false });
  const status = await mc.cortana.status('triage');
  expect(status).toMatchObject({ running: true, crew: [{ title: 'fix', kind: 'ship' }] });
  await expect(mc.cortana.send('nobody', 'x')).rejects.toThrow(/no such Cortana/);
  await mc.cortana.teardown('triage', { force: true });
});

test('teardown refuses while her crew has work in flight, and force discards it', async () => {
  const rec = await seed();
  await mc.cortana.start('triage', { trust: false });
  const her = build(rec.homePath, 'cortana-triage');
  const m = her.newMission({ project: her.listProjects()[0]!.id, type: 'build', goal: 'g' });
  const pilot = await her.spawn({ missionId: m.id, kind: 'ship', title: 'work', harness: 'fake', trust: false });
  await expect(mc.cortana.teardown('triage')).rejects.toThrow(/refusing to tear down triage: 1 agent\(s\) in flight/);
  expect(store.getCortanaHome('triage')).toBeTruthy();

  const herEndpoint = store.getAgent('cortana-triage')!.endpoint!;
  expect(await mc.cortana.teardown('triage', { force: true, purge: true })).toMatchObject({ ok: true, purged: true });
  expect(await tmux.status(herEndpoint)).toBe('missing');
  expect(existsSync(pilot.worktree)).toBe(false);
  expect(existsSync(rec.homePath)).toBe(false);
  expect(store.getCortanaHome('triage')).toBeUndefined();
  expect(store.getAgent('cortana-triage')?.state).toBe('retired');
});

test('a clean teardown keeps her home unless asked to purge', async () => {
  const rec = await seed();
  await mc.cortana.start('triage', { trust: false });
  expect(await mc.cortana.teardown('triage')).toMatchObject({ purged: false });
  expect(existsSync(rec.homePath)).toBe(true);
  await expect(mc.cortana.status('triage')).rejects.toThrow(/no such Cortana/);
});

test('sync waits for her to be quiet and then brings her config up to date', async () => {
  const rec = await seed();
  await writeFile(join(home, 'config', 'dispatch.md'), 'Use fake for everything.\n');
  await mc.cortana.start('triage', { trust: false });
  await waitFor(async () => (await mc.verdict(store.getAgent('cortana-triage')!)).state === 'idle');

  const her = build(rec.homePath, 'cortana-triage');
  const m = her.newMission({ project: her.listProjects()[0]!.id, type: 'build', goal: 'g' });
  await her.spawn({ missionId: m.id, kind: 'ship', title: 'work', harness: 'fake', trust: false });
  await expect(mc.cortana.sync('triage')).rejects.toThrow(/still in flight/);
  await her.teardown((await her.fleet())[0]!.agent, { force: true });

  await mc.cortana.send('triage', 'slow task');
  await waitFor(async () => (await mc.verdict(store.getAgent('cortana-triage')!)).state === 'busy');
  await expect(mc.cortana.sync('triage')).rejects.toThrow(/she is busy/);
  await waitFor(async () => (await mc.verdict(store.getAgent('cortana-triage')!)).state === 'idle');

  expect(await mc.cortana.sync('triage')).toEqual({ synced: true, cortana: 'triage' });
  expect(readFileSync(join(rec.homePath, 'config', 'dispatch.md'), 'utf8')).toBe('Use fake for everything.\n');
  await mc.cortana.teardown('triage', { force: true });
});

test('her own harness can differ from the Commander\'s', async () => {
  await seed({ harness: 'fake' });
  expect(store.getCortanaHome('triage')?.harness).toBe('fake');
  await mc.cortana.start('triage', { trust: false });
  expect(store.getAgent('cortana-triage')?.harness).toBe('fake');
  await mc.cortana.teardown('triage', { force: true });
});
