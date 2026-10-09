import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, Store } from '@masterchief/core';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { runCli } from './cli.js';
import { fakeHarness } from './fake-harness.js';
import { Mc } from './mc.js';
import { TmuxBackend } from './tmux.js';
import { freshWorktrees } from './worktree-provider.js';

let repo: string;
let home: string;
let store: Store;
let tmux: TmuxBackend;
let mc: Mc;
let clock: number;

const STUB = `
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const name = process.argv[2];
const file = join(process.env.MC_HOME, name + '.pid');
writeFileSync(file, String(process.pid));
process.on('SIGTERM', () => { rmSync(file, { force: true }); process.exit(0); });
setInterval(() => {}, 1000);
`;

const waitFor = async (fn: () => Promise<boolean> | boolean, ms = 8000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('timed out');
};

beforeEach(async () => {
  repo = await realpath(await mkdtemp(join(tmpdir(), 'mc-afkrepo-')));
  home = await realpath(await mkdtemp(join(tmpdir(), 'mc-afkhome-')));
  const sh = (...a: string[]) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { cwd: repo });
  sh('init', '-q', '-b', 'main');
  await writeFile(join(repo, 'a.txt'), 'a');
  sh('add', '.');
  sh('commit', '-q', '-m', 'init');
  await writeFile(join(home, 'stub-cli.mjs'), STUB);
  store = new Store(openDb());
  tmux = new TmuxBackend({ socket: `mc-afk-${process.pid}-${Date.now()}` });
  clock = 1_000_000;
  mc = new Mc({ store, tmux, worktrees: freshWorktrees, home, enterDelayMs: 20, cliPath: join(home, 'stub-cli.mjs'), harnessIds: () => ['fake'], harnessFor: () => fakeHarness });
  await mkdir(join(home, 'config'), { recursive: true });
  await writeFile(join(home, 'config', 'roles.json'), JSON.stringify({ global: { pilot: { harness: 'fake' }, sentinel: { harness: 'fake' } } }));
});
afterEach(async () => {
  await mc.afk.stop().catch(() => undefined);
  await mc.stopWatcher().catch(() => undefined);
  await tmux.killServer();
  await rm(repo, { recursive: true, force: true });
  await rm(home, { recursive: true, force: true });
});

const setup = async (type: 'build' | 'investigate' = 'build') => {
  const project = await mc.addProject({ path: repo });
  return mc.newMission({ project: project.id, type, goal: 'g' });
};
const kinds = () => store.listAfkItems().map((i) => i.kind);

test('away mode turns on and off with a daemon, and refuses to double start or stop when off', async () => {
  expect(await mc.afk.status()).toMatchObject({ active: false, queued: 0 });
  await expect(mc.afk.stop()).rejects.toThrow(/not on/);
  const started = await mc.afk.start({ note: 'lunch' });
  expect(started).toMatchObject({ active: true, daemon: { running: true, started: true } });
  expect(store.isAfkActive()).toBe(true);
  expect(await mc.watchStatus()).toMatchObject({ running: true });
  await expect(mc.afk.start()).rejects.toThrow(/already on/);
  const brief = await mc.afk.stop();
  expect(brief).toMatchObject({ note: 'lunch', needsYou: [], activity: [] });
  expect(brief.text).toContain('Nothing needs a decision.');
  expect(store.isAfkActive()).toBe(false);
  expect((await mc.afk.status()).daemon.running).toBe(false);
});

test('only events after start are triaged, once each', async () => {
  const m = await setup();
  store.addEvent({ missionId: m.id, agentId: 'old', kind: 'dead', payload: { role: 'pilot' } });
  await mc.afk.start();
  expect(await mc.afk.process()).toEqual([]);
  store.addEvent({ missionId: m.id, agentId: 'a1', kind: 'blocked', payload: { role: 'pilot', reason: 'no-events-yet', tail: 'Do you trust this folder?' } });
  expect(await mc.afk.process()).toHaveLength(1);
  expect(await mc.afk.process()).toEqual([]);
  expect(kinds()).toEqual(['blocked']);
});

test('events are sorted into things that need a human and things that do not', async () => {
  const m = await setup();
  await mc.afk.start();
  const pilot = await mc.spawn({ missionId: m.id, kind: 'ship', title: 'login form', brief: 'go', trust: false });
  const sent = await mc.spawn({ missionId: m.id, kind: 'sentinel', title: 'probe', brief: 'go', trust: false });
  await writeFile(join(pilot.worktree, 'wip.txt'), 'x');
  execFileSync('git', ['add', '.'], { cwd: pilot.worktree });
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'wip'], { cwd: pilot.worktree });
  const ev = (agentId: string, kind: string, payload: Record<string, unknown>) =>
    store.addEvent({ missionId: m.id, agentId, kind, payload: { role: payload.role ?? 'pilot', taskId: payload.taskId ?? null, ...payload } });

  ev(pilot.agentId, 'finished', { taskId: pilot.taskId });
  ev(sent.agentId, 'finished', { role: 'sentinel', taskId: sent.taskId });
  ev('cortana-x', 'finished', { role: 'cortana' });
  ev('commander', 'finished', { role: 'commander' });
  ev(pilot.agentId, 'blocked', { taskId: pilot.taskId, reason: 'no-events-yet', tail: 'trust this folder?' });
  ev(pilot.agentId, 'blocked', { taskId: pilot.taskId, reason: 'awaiting-input', tail: 'Allow this fetch?' });
  ev(pilot.agentId, 'dead', { taskId: pilot.taskId, tail: 'bye' });
  ev(pilot.agentId, 'stale', { taskId: pilot.taskId, count: 1 });
  ev(pilot.agentId, 'stale', { taskId: pilot.taskId, count: 2 });
  ev(pilot.agentId, 'landed', { taskId: pilot.taskId, mode: 'local-only' });
  ev(pilot.agentId, 'teardown', {});
  await mc.afk.process();

  const items = store.listAfkItems();
  expect(items.map((i) => [i.kind, i.needsHuman])).toEqual([
    ['ready', false], ['report', false], ['cortana-report', false], ['blocked', true], ['blocked', true], ['dead', true], ['stale', false], ['stale', true], ['landed', false],
  ]);
  expect(items[0]!.summary).toBe(`pilot ${pilot.agentId} finished "login form": ready for review`);
  expect(items[1]!.summary).toContain('report not written');
  expect(items[3]!.detail).toBe('trust this folder?');
  expect(items[4]!.summary).toContain('waiting for input');
  expect(items[5]!.summary).toContain('left unlanded work');
});

test('while away the Commander is not nudged; on return it gets one pointer and the brief is kept', async () => {
  const m = await setup();
  const launch = await fakeHarness.prepare({ agentId: 'commander', role: 'commander', cwd: repo, stateDir: join(home, 'state'), initialPrompt: 'start' });
  const ep = await tmux.create({ name: 'commander', cwd: repo, command: launch.command, env: launch.env });
  store.createAgent({ id: 'commander', role: 'commander', harness: 'fake', endpoint: ep, gen: launch.gen, hookLog: launch.hookLog });
  await waitFor(async () => (await mc.verdict(store.getAgent('commander')!)).state === 'idle');

  await mc.afk.start({ note: 'meeting' });
  const pilot = await mc.spawn({ missionId: m.id, kind: 'ship', title: 'work', brief: 'go', trust: false });
  await waitFor(async () => (await mc.verdict(store.getAgent(pilot.agentId)!)).state === 'idle');
  const w = mc.watcher({ now: () => clock });
  expect((await w.tick()).map((e) => e.kind)).toEqual(['finished']);
  await mc.afk.process();
  expect(await tmux.capture(ep, 80)).not.toContain('[mc wake]');
  expect(store.getSetting('wake_cursor')).toBeUndefined();
  expect(await mc.afk.status()).toMatchObject({ queued: 1, needYou: 0 });

  const brief = await mc.afk.stop();
  expect(brief.activity.map((a) => a.kind)).toEqual(['ready']);
  expect(brief.text).toContain('Away for');
  expect(brief.text).toContain('meeting');
  expect(brief.text).toContain('Nothing needs a decision.');
  await waitFor(async () => (await tmux.capture(ep, 80)).includes('[mc afk-return] 1 item(s) queued'));
  expect(store.listAfkItems()).toEqual([]);
  const { pointerSent, ...stored } = brief;
  expect(pointerSent).toBe(true);
  expect(mc.afk.brief({ last: true })).toEqual(stored);
  expect(() => mc.afk.brief()).not.toThrow();

  // The normal wake must not replay what the brief already covered.
  const before = (await tmux.capture(ep, 80)).split('[mc wake]').length;
  await w.tick();
  expect((await tmux.capture(ep, 80)).split('[mc wake]').length).toBe(before);
});

test('the brief lists what needs a decision with a command to look at it', async () => {
  await setup();
  await mc.afk.start();
  store.addEvent({ missionId: null, agentId: 'pilot-ab12', kind: 'dead', payload: { role: 'pilot', tail: 'segfault' } });
  await mc.afk.process();
  const brief = mc.afk.brief();
  expect(brief.needsYou).toHaveLength(1);
  expect(brief.text).toContain('1 item(s) need you:');
  expect(brief.text).toContain('[mc status pilot-ab12]');
  expect(() => new Mc({ store: new Store(openDb()), tmux, worktrees: freshWorktrees, home }).afk.brief({ last: true })).toThrow(/no previous away brief/);
});

test('the daemon refuses to run when away mode is off, and the CLI reports status', async () => {
  const out: string[] = [];
  const io = { out: (t: string) => out.push(t), err: (t: string) => out.push(t) };
  expect(await runCli(['afk', 'run'], mc, io)).toBe(1);
  expect(out.join('')).toContain('away mode is not on');
  out.length = 0;
  expect(await runCli(['afk', 'status'], mc, io)).toBe(0);
  expect(JSON.parse(out.join(''))).toMatchObject({ active: false });
  out.length = 0;
  expect(await runCli(['afk', 'wat'], mc, io)).toBe(1);
});

test('the daemon loop triages in the background until aborted', async () => {
  await setup();
  await mc.afk.start();
  await mc.stopWatcher();
  // Replace the stub daemon with the real loop in this process.
  const lock = await mc.lockStatus('afk.pid');
  process.kill(lock.pid!, 'SIGTERM');
  await waitFor(async () => !(await mc.lockStatus('afk.pid')).running);
  const ctl = new AbortController();
  const running = mc.afk.run(ctl.signal, 20);
  store.addEvent({ missionId: null, agentId: 'x', kind: 'blocked', payload: { role: 'pilot' } });
  await waitFor(() => store.listAfkItems().length === 1);
  ctl.abort();
  await running;
  expect((await mc.lockStatus('afk.pid')).running).toBe(false);
});

test('on return the pointer is not typed over the captain, but the brief is still handed over', async () => {
  const m = await setup();
  const launch = await fakeHarness.prepare({ agentId: 'commander', role: 'commander', cwd: repo, stateDir: join(home, 'state'), initialPrompt: 'start' });
  const ep = await tmux.create({ name: 'commander', cwd: repo, command: launch.command, env: launch.env });
  store.createAgent({ id: 'commander', role: 'commander', harness: 'fake', endpoint: ep, gen: launch.gen, hookLog: launch.hookLog });
  await waitFor(async () => (await mc.verdict(store.getAgent('commander')!)).state === 'idle');
  await mc.afk.start();
  store.addEvent({ missionId: m.id, agentId: 'pilot-x', kind: 'dead', payload: { role: 'pilot' } });
  await tmux.sendText(ep, 'draft: typing as the captain returns');
  await waitFor(async () => (await tmux.capture(ep, 30)).includes('draft: typing as the captain returns'));
  const brief = await mc.afk.stop();
  expect(brief.pointerSent).toBe(false);
  expect(brief.needsYou).toHaveLength(1);
  expect(await tmux.capture(ep, 30)).not.toContain('[mc afk-return]');
  expect(mc.afk.brief({ last: true }).needsYou).toHaveLength(1);
}, 20_000);
