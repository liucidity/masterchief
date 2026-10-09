import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, Store } from '@masterchief/core';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { fakeHarness } from './fake-harness.js';
import { Mc, McError } from './mc.js';
import { TmuxBackend } from './tmux.js';
import { freshWorktrees } from './worktree-provider.js';

let repo: string;
let home: string;
let store: Store;
let tmux: TmuxBackend;
let mc: Mc;
const sh = (...a: string[]) => execFileSync('git', a, { cwd: repo, encoding: 'utf8' }).trim();

const waitFor = async (fn: () => Promise<boolean> | boolean, ms = 6000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('timed out');
};

beforeEach(async () => {
  repo = await realpath(await mkdtemp(join(tmpdir(), 'mc-repo-')));
  home = await realpath(await mkdtemp(join(tmpdir(), 'mc-home-')));
  sh('init', '-q', '-b', 'main');
  sh('config', 'user.email', 't@t');
  sh('config', 'user.name', 't');
  await writeFile(join(repo, 'a.txt'), 'a');
  sh('add', '.');
  sh('commit', '-q', '-m', 'init');
  store = new Store(openDb());
  tmux = new TmuxBackend({ socket: `mc-mctest-${process.pid}-${Date.now()}` });
  mc = new Mc({
    store,
    tmux,
    worktrees: freshWorktrees,
    home,
    enterDelayMs: 20,
    harnessFor: (id) => {
      if (id === 'fake') return fakeHarness;
      throw new Error(`unknown harness: ${id}`);
    },
  });
});
afterEach(async () => {
  await tmux.killServer();
  await rm(repo, { recursive: true, force: true });
  await rm(home, { recursive: true, force: true });
});

const setup = async (type: 'build' | 'investigate' = 'build') => {
  const project = await mc.addProject({ path: repo });
  const mission = mc.newMission({ project: project.id, type, goal: 'Add OAuth login' });
  return { project, mission };
};
const spawn = (missionId: string, extra = {}) =>
  mc.spawn({ missionId, kind: 'ship', title: 'do it', harness: 'fake', trust: false, ...extra });
const screen = async (ref: string) => (await mc.status(ref)).screen;

test('addProject accepts a repo root and rejects other paths and duplicates', async () => {
  const p = await mc.addProject({ path: repo, mode: 'no-mistakes' });
  expect(p).toMatchObject({ path: repo, defaultBranch: 'main', deliveryMode: 'no-mistakes' });
  await expect(mc.addProject({ path: repo })).rejects.toThrow(/already registered/);
  await expect(mc.addProject({ path: home })).rejects.toThrow(/not a git repository/);
  await expect(mc.addProject({ path: join(repo, 'sub') })).rejects.toThrow(McError);
  expect(mc.findProject(repo).id).toBe(p.id);
  expect(mc.findProject(p.id.slice(0, 6)).id).toBe(p.id);
});

test('spawn validates harness, model, effort and mission state before touching anything', async () => {
  const { mission } = await setup();
  await expect(spawn(mission.id, { harness: 'nope' })).rejects.toThrow(/unknown harness/);
  await expect(spawn(mission.id, { effort: 'extreme' })).rejects.toThrow(/invalid effort/);
  await expect(spawn(mission.id, { title: ' ' })).rejects.toThrow(/needs a title/);
  expect(await tmux.list()).toEqual([]);
  store.setMissionStatus(mission.id, 'aborted');
  await expect(spawn(mission.id)).rejects.toThrow(/mission is aborted/);
});

test('spawn starts a pilot in its own worktree, delivers the brief and reports idle after its turn', async () => {
  const { mission } = await setup();
  const r = await spawn(mission.id, { brief: 'hello brief', model: 'm1', effort: 'high' });
  expect(r.agentId).toMatch(/^pilot-[0-9a-f]{4}$/);
  expect(r.worktree).toBe(join(repo, '.mc/wt', r.agentId));
  expect(existsSync(join(r.worktree, 'a.txt'))).toBe(true);

  await waitFor(async () => (await screen(r.agentId)).includes('got: hello brief'));
  await waitFor(async () => (await mc.status(r.agentId)).verdict.state === 'idle');

  const st = await mc.status(r.taskId.slice(0, 8));
  expect(st.task).toMatchObject({ kind: 'ship', status: 'running', agentId: r.agentId });
  expect(st.agent).toMatchObject({ role: 'pilot', harness: 'fake', model: 'm1', effort: 'high', slot: 0 });
  expect(store.getMission(mission.id)?.status).toBe('running');
  expect(store.listEvents().map((e) => e.kind)).toEqual(['spawned']);
  expect(await mc.status()).toMatchObject([{ agent: r.agentId, verdict: { state: 'idle' } }]);
});

test('sentinels get a read-only checkout and a report directory', async () => {
  const { mission } = await setup('investigate');
  const r = await mc.spawn({ missionId: mission.id, kind: 'sentinel', title: 'probe', harness: 'fake', trust: false });
  expect(r.agentId).toMatch(/^sentinel-/);
  expect(r.branch).toBe('');
  expect(existsSync(join(home, 'data', r.taskId))).toBe(true);
  expect((await mc.status(r.agentId)).agent.role).toBe('sentinel');
});

test('parallel spawns get separate worktrees and slots', async () => {
  const { mission } = await setup();
  const [a, b] = await Promise.all([spawn(mission.id), spawn(mission.id)]);
  expect(a.worktree).not.toBe(b.worktree);
  const slots = [a, b].map((r) => store.getAgent(r.agentId)!.slot).sort();
  expect(slots).toEqual([0, 1]);
});

test('a failed spawn leaves no worktree, window or live agent behind', async () => {
  const { mission } = await setup();
  mc = new Mc({ store, tmux, worktrees: freshWorktrees, home, harnessFor: () => ({ ...fakeHarness, prepare: async () => { throw new Error('boom'); } }) });
  await expect(spawn(mission.id)).rejects.toThrow('boom');
  expect(sh('worktree', 'list').split('\n')).toHaveLength(1);
  expect(await tmux.list()).toEqual([]);
  const tasks = store.listTasks(mission.id);
  expect(tasks).toHaveLength(1);
  expect(tasks[0]!.status).toBe('failed');
  expect(store.listAgents().every((a) => a.state === 'retired')).toBe(true);
  expect(store.getWorkspace(store.listAgents()[0]!.id)).toBeUndefined();
});

test('send pastes text and presses Enter, accepts keys, and refuses a dead agent', async () => {
  const { mission } = await setup();
  const r = await spawn(mission.id);
  await waitFor(async () => (await screen(r.agentId)).includes('ready'));
  await mc.send(r.agentId, { text: 'ping' });
  await waitFor(async () => (await screen(r.agentId)).includes('got: ping'));
  await mc.send(r.agentId, { text: 'typed', noEnter: true });
  await mc.send(r.agentId, { keys: ['Enter'] });
  await waitFor(async () => (await screen(r.agentId)).includes('got: typed'));
  await expect(mc.send(r.agentId, {})).rejects.toThrow(/nothing to send/);
  await mc.send(r.agentId, { interrupt: true });
  await waitFor(async () => (await mc.status(r.agentId)).verdict.state === 'dead');
  await expect(mc.send(r.agentId, { text: 'x' })).rejects.toThrow(/endpoint is dead/);
});

test('teardown refuses while work is unlanded and succeeds once it is merged', async () => {
  const { mission } = await setup();
  const r = await spawn(mission.id);
  await waitFor(async () => (await screen(r.agentId)).includes('ready'));

  await writeFile(join(r.worktree, 'new.txt'), 'x');
  await expect(mc.teardown(r.agentId)).rejects.toThrow(/uncommitted changes/);

  execFileSync('git', ['add', '.'], { cwd: r.worktree });
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'work'], { cwd: r.worktree });
  await expect(mc.teardown(r.agentId)).rejects.toThrow(/1 commit\(s\) on .* not in main/);
  expect(existsSync(r.worktree)).toBe(true);

  sh('merge', '-q', '--ff-only', r.branch);
  await mc.teardown(r.agentId);
  expect(existsSync(r.worktree)).toBe(false);
  expect(await tmux.status(store.getAgent(r.agentId)!.endpoint!)).toBe('missing');
  expect(store.getAgent(r.agentId)).toMatchObject({ state: 'retired', slot: null });
  expect(store.getTask(r.taskId)?.status).toBe('done');
  await expect(mc.teardown(r.agentId)).rejects.toThrow(/already torn down/);
});

test('teardown --force discards unlanded work and can mark the task failed', async () => {
  const { mission } = await setup();
  const r = await spawn(mission.id);
  await writeFile(join(r.worktree, 'junk.txt'), 'x');
  await mc.teardown(r.agentId, { force: true, outcome: 'failed' });
  expect(existsSync(r.worktree)).toBe(false);
  expect(store.getTask(r.taskId)?.status).toBe('failed');
  expect(store.listEvents().map((e) => e.kind)).toEqual(['spawned', 'teardown']);
});

test('the agent temp dir does not make a clean worktree look dirty', async () => {
  const { mission } = await setup();
  const r = await spawn(mission.id);
  expect(existsSync(join(r.worktree, '.mc-tmp'))).toBe(true);
  await mc.teardown(r.agentId);
});

test('events stay put until acknowledged, so a Commander that crashed sees them again', async () => {
  const { mission } = await setup();
  await spawn(mission.id);
  const first = mc.events();
  expect(first.events.map((e) => e.kind)).toEqual(['spawned']);
  expect(first.ack).toBe(`mc events --ack ${first.next}`);
  expect(mc.events().events).toHaveLength(1);
  expect(mc.events({ after: 0 }).events).toHaveLength(1);

  expect(mc.events({ ack: first.next! })).toMatchObject({ events: [], acknowledged: first.next, next: null, ack: null });
  expect(mc.events().events).toEqual([]);
  store.addEvent({ missionId: mission.id, agentId: 'x', kind: 'finished', payload: {} });
  const second = mc.events();
  expect(second.events.map((e) => e.kind)).toEqual(['finished']);
  expect(mc.events({ ack: 1 }).acknowledged).toBe(first.next); // an older ack never moves the cursor back
  expect(() => mc.events({ ack: 99 })).toThrow(/cannot acknowledge 99: the latest event is 2/);
  expect(() => mc.events({ ack: -1 })).toThrow(/cannot acknowledge/);
  mc.events({ ack: second.next! });
  expect(mc.events().events).toEqual([]);
});

test('status says what needs attention from the current state alone', async () => {
  const { mission } = await setup();
  const done = await spawn(mission.id, { brief: 'first' });
  const waiting = await spawn(mission.id, { brief: 'start' });
  const dead = await spawn(mission.id, { brief: 'start' });
  const sentinel = await mc.spawn({ missionId: mission.id, kind: 'sentinel', title: 's', harness: 'fake', brief: 'probe', trust: false });
  const busy = await spawn(mission.id, { brief: 'start' });
  await Promise.all([done, waiting, dead, sentinel, busy].map((r) => waitFor(async () => (await mc.status(r.agentId)).verdict.state === 'idle')));
  await mc.send(waiting.agentId, { text: 'ask me' });
  await mc.send(busy.agentId, { text: 'hang' });
  await mc.send(dead.agentId, { interrupt: true });
  await waitFor(async () => (await mc.status(waiting.agentId)).verdict.state === 'waiting');
  await waitFor(async () => (await mc.status(dead.agentId)).verdict.state === 'dead');
  await waitFor(async () => (await mc.status(busy.agentId)).verdict.state === 'busy');

  const rows = Object.fromEntries((await mc.status()).map((r) => [r.agent, r.attention]));
  expect(rows[done.agentId]).toMatch(/^finished: review its diff/);
  expect(rows[waiting.agentId]).toMatch(/^waiting for input/);
  expect(rows[dead.agentId]).toMatch(/^exited/);
  expect(rows[sentinel.agentId]).toMatch(/^finished: read its report/);
  expect(rows[busy.agentId]).toBeNull();

  mc.review(done.agentId, { verdict: 'reject', notes: 'nope' });
  expect((await mc.status()).find((r) => r.agent === done.agentId)!.attention).toMatch(/^rejected earlier/);
  mc.review(done.agentId, { verdict: 'approve', notes: 'ok' });
  expect((await mc.status()).find((r) => r.agent === done.agentId)!.attention).toMatch(/^approved: land it/);

  const later = new Mc({ store, tmux, worktrees: freshWorktrees, home, now: () => Date.now() / 1000 + 45 * 60, harnessFor: () => fakeHarness });
  expect((await later.status()).find((r) => r.agent === busy.agentId)!.attention).toMatch(/^busy for 4\d minutes/);
}, 30_000);

test('with a guard path, crew members launch with a guard command scoped to their role and worktree', async () => {
  const seen: Array<string[] | undefined> = [];
  const spy = { ...fakeHarness, prepare: async (o: Parameters<typeof fakeHarness.prepare>[0]) => (seen.push(o.guardCommand), fakeHarness.prepare(o)) };
  mc = new Mc({ store, tmux, worktrees: freshWorktrees, home, guardPath: '/opt/mc/guard-main.js', harnessFor: () => spy });
  const { mission } = await setup();
  const pilot = await spawn(mission.id);
  const sentinel = await mc.spawn({ missionId: mission.id, kind: 'sentinel', title: 's', harness: 'fake', trust: false });
  expect(seen[0]).toEqual([process.execPath, '--disable-warning=ExperimentalWarning', '/opt/mc/guard-main.js', '--role', 'pilot', '--worktree', pilot.worktree]);
  expect(seen[1]).toEqual(expect.arrayContaining(['--role', 'sentinel', '--report-dir', join(home, 'data', sentinel.taskId)]));
});

test('for a harness that cannot report turn starts, mc records the prompt when it sends text', async () => {
  const { lastHookEvent } = await import('./busy.js');
  const quiet = { ...fakeHarness, id: 'quiet', recordsSends: true, prepare: async (o: Parameters<typeof fakeHarness.prepare>[0]) => ({ ...(await fakeHarness.prepare(o)), command: ['cat'] }) };
  mc = new Mc({ store, tmux, worktrees: freshWorktrees, home, enterDelayMs: 20, harnessFor: () => quiet });
  const { mission } = await setup();
  const r = await spawn(mission.id);
  const agent = store.getAgent(r.agentId)!;
  expect(await lastHookEvent(agent.hookLog!, agent.gen!)).toBeUndefined();
  await mc.send(r.agentId, { text: 'hello' });
  expect(await lastHookEvent(agent.hookLog!, agent.gen!)).toMatchObject({ event: 'prompt' });
  expect((await mc.status(r.agentId)).verdict).toMatchObject({ state: 'busy' });
});

test('text is refused while the agent waits at a prompt or has a draft, but keys and --force still work', async () => {
  const { mission } = await setup();
  const r = await spawn(mission.id, { brief: 'start' });
  await waitFor(async () => (await mc.status(r.agentId)).verdict.state === 'idle');

  await mc.send(r.agentId, { text: 'draft: half a thought', noEnter: true });
  await waitFor(async () => (await screen(r.agentId)).includes('draft: half a thought'));
  await expect(mc.send(r.agentId, { text: 'hello' })).rejects.toThrow(/input box is not empty/);
  await mc.send(r.agentId, { keys: ['C-u'] });
  await waitFor(async () => !(await screen(r.agentId)).trimEnd().split('\n').at(-1)!.startsWith('draft:'));
  await mc.send(r.agentId, { text: 'hello' });
  await waitFor(async () => (await screen(r.agentId)).includes('got: hello'));

  await mc.send(r.agentId, { text: 'ask permission' });
  await waitFor(async () => (await mc.status(r.agentId)).verdict.state === 'waiting');
  await expect(mc.send(r.agentId, { text: 'yes please' })).rejects.toThrow(/waiting at a prompt, and typing would answer it/);
  await mc.send(r.agentId, { keys: ['C-u'] });
  await mc.send(r.agentId, { text: 'forced', force: true });
  await waitFor(async () => (await screen(r.agentId)).includes('got: forced'));
}, 20_000);

describe_lifecycle();

function describe_lifecycle() {
  const forgotten: string[] = [];
  const withForget = () => ({ ...fakeHarness, forget: async (o: { cwd: string }) => void forgotten.push(o.cwd) });
  const rebuild = () => {
    forgotten.length = 0;
    mc = new Mc({ store, tmux, worktrees: freshWorktrees, home, enterDelayMs: 20, harnessFor: () => withForget() });
  };

  test('teardown and a failed spawn both forget the worktree trust entry', async () => {
    rebuild();
    const { mission } = await setup();
    const r = await spawn(mission.id);
    await mc.teardown(r.agentId);
    expect(forgotten).toEqual([r.worktree]);

    forgotten.length = 0;
    mc = new Mc({ store, tmux, worktrees: freshWorktrees, home, harnessFor: () => ({ ...withForget(), prepare: async () => { throw new Error('boom'); } }) });
    await expect(spawn(mission.id)).rejects.toThrow('boom');
    // Trust may have been registered before the failure, so rollback always asks to forget it.
    expect(forgotten).toHaveLength(1);
    expect(forgotten[0]).toMatch(/\/\.mc\/wt\/pilot-[0-9a-f]{4}$/);
  });

  test('a failure while forgetting trust never blocks cleanup', async () => {
    mc = new Mc({ store, tmux, worktrees: freshWorktrees, home, enterDelayMs: 20, harnessFor: () => ({ ...fakeHarness, forget: async () => { throw new Error('config locked'); } }) });
    const { mission } = await setup();
    const r = await spawn(mission.id);
    await mc.teardown(r.agentId);
    expect(existsSync(r.worktree)).toBe(false);
  });

  test('prune reports stale worktrees, removes clean ones on --apply, and keeps ones with unlanded work unless forced', async () => {
    rebuild();
    const { mission } = await setup();
    const live = await spawn(mission.id);
    const clean = await spawn(mission.id);
    const dirty = await spawn(mission.id);
    await writeFile(join(dirty.worktree, 'wip.txt'), 'x');
    // A crash left two agents retired in the database but their worktrees on disk.
    store.updateAgent(clean.agentId, { state: 'retired', slot: null });
    store.updateAgent(dirty.agentId, { state: 'retired', slot: null });

    const report = await mc.prune();
    expect(report.map((r) => [r.agent, r.removed]).sort()).toEqual([[clean.agentId, false], [dirty.agentId, false]].sort());
    expect(report.find((r) => r.agent === dirty.agentId)!.unlanded[0]).toMatch(/uncommitted/);
    expect(existsSync(clean.worktree)).toBe(true);

    const applied = await mc.prune({ apply: true });
    expect(applied.find((r) => r.agent === clean.agentId)!.removed).toBe(true);
    expect(applied.find((r) => r.agent === dirty.agentId)!.removed).toBe(false);
    expect(existsSync(clean.worktree)).toBe(false);
    expect(existsSync(dirty.worktree)).toBe(true);
    expect(existsSync(live.worktree)).toBe(true);
    expect(forgotten).toContain(clean.worktree);

    const forced = await mc.prune({ apply: true, force: true });
    expect(forced.map((r) => r.agent)).toEqual([dirty.agentId]);
    expect(existsSync(dirty.worktree)).toBe(false);
    expect(existsSync(live.worktree)).toBe(true);
    expect(await mc.prune()).toEqual([]);
  });
}
