import { execFileSync } from 'node:child_process';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, Store } from '@masterchief/core';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { fakeHarness } from './fake-harness.js';
import type { Harness } from './harness.js';
import { Mc } from './mc.js';
import { TmuxBackend } from './tmux.js';
import { Watcher } from './watcher.js';
import { freshWorktrees } from './worktree-provider.js';

let repo: string;
let home: string;
let store: Store;
let tmux: TmuxBackend;
let mc: Mc;
let clock: number;
const tick = (w: Watcher) => w.tick();

const silent: Harness = {
  ...fakeHarness,
  id: 'silent',
  async prepare(opts) {
    return { command: ['sh', '-c', 'echo "Do you trust this folder?"; cat'], env: {}, gen: 'g', hookLog: `${opts.stateDir}/${opts.agentId}.hooks.log` };
  },
};

const waitFor = async (fn: () => Promise<boolean> | boolean, ms = 6000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('timed out');
};

beforeEach(async () => {
  repo = await realpath(await mkdtemp(join(tmpdir(), 'mc-wrepo-')));
  home = await realpath(await mkdtemp(join(tmpdir(), 'mc-whome-')));
  const sh = (...a: string[]) => execFileSync('git', a, { cwd: repo });
  sh('init', '-q', '-b', 'main');
  sh('config', 'user.email', 't@t');
  sh('config', 'user.name', 't');
  await writeFile(join(repo, 'a.txt'), 'a');
  sh('add', '.');
  sh('commit', '-q', '-m', 'init');
  store = new Store(openDb());
  tmux = new TmuxBackend({ socket: `mc-wtest-${process.pid}-${Date.now()}` });
  clock = 1_000_000;
  mc = new Mc({
    store,
    tmux,
    worktrees: freshWorktrees,
    home,
    enterDelayMs: 20,
    harnessFor: (id) => {
      if (id === 'fake') return fakeHarness;
      if (id === 'silent') return silent;
      throw new Error(`unknown harness: ${id}`);
    },
  });
});
afterEach(async () => {
  await tmux.killServer();
  await rm(repo, { recursive: true, force: true });
  await rm(home, { recursive: true, force: true });
});

const watcher = (extra = {}) => mc.watcher({ now: () => clock, unknownAfterSecs: 90, staleAfterSecs: 600, ...extra });
const start = async (harness = 'fake', brief?: string) => {
  const project = await mc.addProject({ path: repo });
  const mission = mc.newMission({ project: project.id, type: 'build', goal: 'g' });
  return mc.spawn({ missionId: mission.id, kind: 'ship', title: 't', harness, brief, trust: false });
};
const kinds = (events: { kind: string }[]) => events.map((e) => e.kind);

test('a finished turn is reported once and persisted, even across a watcher restart', async () => {
  const r = await start('fake', 'job');
  await waitFor(async () => (await mc.status(r.agentId)).verdict.state === 'idle');
  const w = watcher();
  expect(kinds(await tick(w))).toEqual(['finished']);
  expect(store.getAgent(r.agentId)?.state).toBe('idle');
  expect(await tick(w)).toEqual([]);
  expect(await tick(watcher())).toEqual([]);
});

test('busy then idle again reports each finished turn', async () => {
  const r = await start('fake', 'job');
  await waitFor(async () => (await mc.status(r.agentId)).verdict.state === 'idle');
  const w = watcher();
  await tick(w);
  await mc.send(r.agentId, { text: 'slow one' });
  await waitFor(async () => (await mc.status(r.agentId)).verdict.state === 'busy');
  expect(await tick(w)).toEqual([]);
  expect(store.getAgent(r.agentId)?.state).toBe('busy');
  await waitFor(async () => (await mc.status(r.agentId)).verdict.state === 'idle');
  expect(kinds(await tick(w))).toEqual(['finished']);
});

test('a dead agent is reported once with the end of its screen', async () => {
  const r = await start('fake', 'job');
  await waitFor(async () => (await mc.status(r.agentId)).verdict.state === 'idle');
  const w = watcher();
  await tick(w);
  await mc.send(r.agentId, { interrupt: true });
  await waitFor(async () => (await mc.status(r.agentId)).verdict.state === 'dead');
  const events = await tick(w);
  expect(kinds(events)).toEqual(['dead']);
  expect(events[0]!.payload).toMatchObject({ role: 'pilot', reason: 'endpoint-exited' });
  expect(await tick(w)).toEqual([]);
});

test('an agent silent past the threshold is reported blocked once, with its screen, and recovers', async () => {
  const r = await start('silent');
  await waitFor(async () => (await mc.status(r.agentId)).screen.includes('trust this folder'));
  const w = watcher();
  expect(await tick(w)).toEqual([]);
  clock += 89;
  expect(await tick(w)).toEqual([]);
  clock += 2;
  const events = await tick(w);
  expect(kinds(events)).toEqual(['blocked']);
  expect(JSON.stringify(events[0]!.payload)).toContain('trust this folder');
  clock += 500;
  expect(await tick(w)).toEqual([]);
});

test('a busy agent that goes quiet is reported stale on a growing count', async () => {
  const r = await start('fake', 'job');
  await waitFor(async () => (await mc.status(r.agentId)).verdict.state === 'idle');
  const w = watcher();
  await tick(w);
  await mc.send(r.agentId, { text: 'hang' });
  await waitFor(async () => (await mc.status(r.agentId)).verdict.state === 'busy');
  const since = (await mc.status(r.agentId)).verdict.since!;
  clock = since + 599;
  expect(await tick(w)).toEqual([]);
  clock = since + 601;
  const first = await tick(w);
  expect(kinds(first)).toEqual(['stale']);
  expect(first[0]!.payload).toMatchObject({ count: 1 });
  clock += 300;
  expect(await tick(w)).toEqual([]);
  clock += 400;
  expect((await tick(w))[0]!.payload).toMatchObject({ count: 2 });
});

test('the Commander is nudged only between its turns, and the wake is not lost', async () => {
  const r = await start('fake', 'job');
  const commanderLaunch = await fakeHarness.prepare({ agentId: 'commander', role: 'commander', cwd: repo, stateDir: join(home, 'state') });
  const ep = await tmux.create({ name: 'commander', cwd: repo, command: commanderLaunch.command, env: commanderLaunch.env });
  store.createAgent({ id: 'commander', role: 'commander', harness: 'fake', endpoint: ep, gen: commanderLaunch.gen, hookLog: commanderLaunch.hookLog });
  await waitFor(async () => (await tmux.capture(ep, 80)).includes('ready'));
  await waitFor(async () => (await mc.status(r.agentId)).verdict.state === 'idle');

  // Commander is mid-turn (a slow one): the wake waits and the cursor stays put.
  await tmux.sendText(ep, 'slow work');
  await tmux.sendKeys(ep, 'Enter');
  await waitFor(async () => (await mc.verdict(store.getAgent('commander')!)).state === 'busy');
  const w = watcher();
  expect(kinds(await tick(w))).toEqual(['finished']);
  expect(await tmux.capture(ep, 80)).not.toContain('[mc wake]');
  expect(store.getSetting('wake_cursor')).toBeUndefined();

  // Once the turn ends, the next tick delivers it, naming ids only.
  await waitFor(async () => (await mc.verdict(store.getAgent('commander')!)).state === 'idle');
  await tick(w);
  await waitFor(async () => (await tmux.capture(ep, 80)).includes(`[mc wake] 1 new event(s): finished ${r.agentId}`));
  expect(Number(store.getSetting('wake_cursor'))).toBeGreaterThan(0);
});

test('the Commander receives one wake per batch once it is idle', async () => {
  const r = await start('fake', 'job');
  const launch = await fakeHarness.prepare({ agentId: 'commander', role: 'commander', cwd: repo, stateDir: join(home, 'state'), initialPrompt: 'start' });
  const ep = await tmux.create({ name: 'commander', cwd: repo, command: launch.command, env: launch.env });
  store.createAgent({ id: 'commander', role: 'commander', harness: 'fake', endpoint: ep, gen: launch.gen, hookLog: launch.hookLog });
  await waitFor(async () => (await mc.verdict(store.getAgent('commander')!)).state === 'idle');
  await waitFor(async () => (await mc.status(r.agentId)).verdict.state === 'idle');
  const w = watcher();
  await tick(w);
  await waitFor(async () => (await tmux.capture(ep, 80)).includes('got: [mc wake] 1 new event(s): finished pilot-'));
  expect(Number(store.getSetting('wake_cursor'))).toBeGreaterThan(0);
  const screenAfter = await tmux.capture(ep, 80);
  await tick(w);
  expect((await tmux.capture(ep, 80)).split('[mc wake]').length).toBe(screenAfter.split('[mc wake]').length);
});

test('run stops when aborted', async () => {
  await start('fake', 'job');
  const ctl = new AbortController();
  const done = watcher().run(ctl.signal, 20);
  await new Promise((r) => setTimeout(r, 120));
  ctl.abort();
  await done;
  expect(store.listEvents().some((e) => e.kind === 'finished')).toBe(true);
});

test('a permission prompt is reported at once as blocked, then the agent carries on without more alarms', async () => {
  const r = await start('fake', 'job');
  await waitFor(async () => (await mc.status(r.agentId)).verdict.state === 'idle');
  const w = watcher();
  await tick(w);
  await mc.send(r.agentId, { text: 'ask me' });
  await waitFor(async () => (await mc.status(r.agentId)).verdict.state === 'waiting');
  const events = await tick(w);
  expect(kinds(events)).toEqual(['blocked']);
  expect(events[0]!.payload).toMatchObject({ reason: 'awaiting-input', role: 'pilot' });
  expect(store.getAgent(r.agentId)?.state).toBe('waiting');
  expect(await tick(w)).toEqual([]);

  await waitFor(async () => (await mc.status(r.agentId)).verdict.state === 'busy');
  expect(await tick(w)).toEqual([]);
  await waitFor(async () => (await mc.status(r.agentId)).verdict.state === 'idle');
  expect(kinds(await tick(w))).toEqual(['finished']);
}, 15_000);
