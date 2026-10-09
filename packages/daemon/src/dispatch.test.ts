import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, Store } from '@masterchief/core';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { activeRules, parseRoleConfig, resolveRoleSetting } from './dispatch.js';
import { fakeHarness } from './fake-harness.js';
import { Mc } from './mc.js';
import { TmuxBackend } from './tmux.js';
import { freshWorktrees } from './worktree-provider.js';

let repo: string;
let home: string;
let store: Store;
let tmux: TmuxBackend;
let mc: Mc;
const config = (c: unknown) => writeFile(join(home, 'config', 'roles.json'), JSON.stringify(c));

beforeEach(async () => {
  repo = await realpath(await mkdtemp(join(tmpdir(), 'mc-drepo-')));
  home = await realpath(await mkdtemp(join(tmpdir(), 'mc-dhome-')));
  await mkdir(join(home, 'config'));
  const sh = (...a: string[]) => execFileSync('git', a, { cwd: repo });
  sh('init', '-q', '-b', 'main');
  sh('config', 'user.email', 't@t');
  sh('config', 'user.name', 't');
  await writeFile(join(repo, 'a.txt'), 'a');
  sh('add', '.');
  sh('commit', '-q', '-m', 'init');
  store = new Store(openDb());
  tmux = new TmuxBackend({ socket: `mc-dtest-${process.pid}-${Date.now()}` });
  mc = new Mc({ store, tmux, worktrees: freshWorktrees, home, harnessIds: () => ['fake'], harnessFor: (id) => { if (id === 'fake') return fakeHarness; throw new Error(`unknown harness: ${id}`); } });
});
afterEach(async () => {
  await tmux.killServer();
  await rm(repo, { recursive: true, force: true });
  await rm(home, { recursive: true, force: true });
});

const mission = async () => {
  const p = await mc.addProject({ path: repo });
  return { project: p, mission: mc.newMission({ project: p.id, type: 'build', goal: 'g' }) };
};
const spawn = (missionId: string, extra = {}) => mc.spawn({ missionId, kind: 'ship', title: 't', trust: false, ...extra });

test('resolution layers mission over project over global, field by field, for every role', () => {
  const cfg = parseRoleConfig(JSON.stringify({
    global: { commander: { harness: 'claude', model: 'opus', effort: 'xhigh' }, cortana: { harness: 'claude', model: 'opus' }, pilot: { harness: 'claude', model: 'sonnet', effort: 'high' }, small: { model: 'haiku', effort: 'low' } },
    projects: { '/p': { pilot: { model: 'opus' } }, 'proj-id': { pilot: { effort: 'max' } } },
    missions: { m1: { pilot: { effort: 'low' } } },
  }));
  expect(resolveRoleSetting(cfg, 'commander', {})).toEqual({ harness: 'claude', model: 'opus', effort: 'xhigh' });
  expect(resolveRoleSetting(cfg, 'cortana', {})).toEqual({ harness: 'claude', model: 'opus' });
  expect(resolveRoleSetting(cfg, 'pilot', {})).toEqual({ harness: 'claude', model: 'sonnet', effort: 'high' });
  expect(resolveRoleSetting(cfg, 'pilot', { projectPath: '/p' })).toEqual({ harness: 'claude', model: 'opus', effort: 'high' });
  expect(resolveRoleSetting(cfg, 'pilot', { projectId: 'proj-id', projectPath: '/p' })).toEqual({ harness: 'claude', model: 'sonnet', effort: 'max' });
  expect(resolveRoleSetting(cfg, 'pilot', { projectPath: '/p', missionId: 'm1' })).toEqual({ harness: 'claude', model: 'opus', effort: 'low' });
  expect(resolveRoleSetting(cfg, 'sentinel', {})).toEqual({});
  expect(resolveRoleSetting(cfg, 'pilot', { tier: 'small' })).toEqual({ harness: 'claude', model: 'haiku', effort: 'low' });
});

test('the config file is validated with messages that name the problem', () => {
  expect(() => parseRoleConfig('{nope')).toThrow(/not valid JSON/);
  expect(() => parseRoleConfig('[]')).toThrow(/must be an object/);
  expect(() => parseRoleConfig('{"extra":{}}')).toThrow(/unknown top-level key "extra"/);
  expect(() => parseRoleConfig('{"global":{"captain":{}}}')).toThrow(/unknown key "captain"/);
  expect(() => parseRoleConfig('{"global":{"pilot":{"colour":"red"}}}')).toThrow(/unknown field "colour"/);
  expect(() => parseRoleConfig('{"global":{"pilot":{"model":3}}}')).toThrow(/non-empty string/);
});

test('rules count only when they hold real text', () => {
  expect(activeRules('<!-- only a comment -->\n\n')).toBe('');
  expect(activeRules('<!-- c -->\nUse opus for risky work.')).toBe('Use opus for risky work.');
});

test('spawn needs a harness from the command line or from config', async () => {
  const { mission: m } = await mission();
  await expect(spawn(m.id)).rejects.toThrow(/no harness: pass --harness or set one for "pilot"/);
  await config({ global: { pilot: { harness: 'fake', effort: 'high' } } });
  const r = await spawn(m.id);
  expect(store.getAgent(r.agentId)).toMatchObject({ harness: 'fake', effort: 'high', model: null });
});

test('config model and effort apply only to the configured harness, and explicit values win', async () => {
  const { mission: m } = await mission();
  await config({ global: { pilot: { harness: 'other', model: 'cfg-model', effort: 'low' } } });
  const explicit = await spawn(m.id, { harness: 'fake' });
  expect(store.getAgent(explicit.agentId)).toMatchObject({ harness: 'fake', model: null, effort: null });
  await config({ global: { pilot: { harness: 'fake', model: 'cfg-model', effort: 'low' } } });
  const overridden = await spawn(m.id, { model: 'mine', effort: 'high' });
  expect(store.getAgent(overridden.agentId)).toMatchObject({ model: 'mine', effort: 'high' });
});

test('once dispatch rules exist, spawn refuses to pick a harness for the Commander', async () => {
  const { mission: m } = await mission();
  await config({ global: { pilot: { harness: 'fake' } } });
  await mc.dispatchInit();
  expect((await mc.dispatchInfo()).rules).toBeNull();
  expect(await spawn(m.id)).toBeTruthy();

  await writeFile(join(home, 'config', 'dispatch.md'), 'Use fake for everything.\n');
  await expect(spawn(m.id)).rejects.toThrow(/dispatch rules exist .* pass --harness/);
  expect(await spawn(m.id, { harness: 'fake' })).toBeTruthy();
  expect(await mc.dispatchInit()).toMatchObject({ created: false });
  const info = await mc.dispatchInfo();
  expect(info.rules).toBe('Use fake for everything.\n');
  expect(info.harnesses).toEqual(expect.arrayContaining([{ id: 'fake', efforts: ['low', 'high'] }]));
});

test('the small tier picks the configured small model', async () => {
  const { mission: m } = await mission();
  await config({ global: { pilot: { harness: 'fake', effort: 'high' }, small: { effort: 'low', model: 'tiny' } } });
  const normal = await spawn(m.id);
  const small = await spawn(m.id, { tier: 'small' });
  expect(store.getAgent(normal.agentId)).toMatchObject({ model: null, effort: 'high' });
  expect(store.getAgent(small.agentId)).toMatchObject({ model: 'tiny', effort: 'low' });
});

test('invalid combinations are refused whether typed or configured, and a bad config file is reported', async () => {
  const { mission: m } = await mission();
  await expect(spawn(m.id, { harness: 'fake', effort: 'extreme' })).rejects.toThrow(/invalid effort/);
  await config({ global: { pilot: { harness: 'fake', model: 'bad-model' } } });
  await expect(spawn(m.id)).rejects.toThrow(/invalid model: bad-model/);
  await writeFile(join(home, 'config', 'roles.json'), '{oops');
  await expect(spawn(m.id, { harness: 'fake' })).rejects.toThrow(/roles.json is not valid JSON/);
  expect(store.listAgents().every((a) => a.state === 'retired')).toBe(true);
  expect(await tmux.list()).toEqual([]);
});

test('project settings apply by path or id and mission settings win', async () => {
  const { project, mission: m } = await mission();
  await config({ global: { pilot: { harness: 'fake', effort: 'high' } }, projects: { [repo]: { pilot: { effort: 'low' } } }, missions: { [m.id]: { pilot: { effort: 'high' } } } });
  const r = await spawn(m.id);
  expect(store.getAgent(r.agentId)?.effort).toBe('high');
  await config({ global: { pilot: { harness: 'fake', effort: 'high' } }, projects: { [project.id]: { pilot: { effort: 'low' } } } });
  expect(store.getAgent((await spawn(m.id)).agentId)?.effort).toBe('low');
});

test('the Commander takes its harness, model and effort from config unless told otherwise', async () => {
  await config({ global: { commander: { harness: 'fake', effort: 'high' } } });
  await mc.commanderStart({ trust: false });
  expect(store.getAgent('commander')).toMatchObject({ harness: 'fake', effort: 'high' });
  await expect(mc.commanderStart({ effort: 'extreme' })).rejects.toThrow(/invalid effort/);
});
