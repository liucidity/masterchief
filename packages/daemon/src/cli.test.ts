import { execFileSync } from 'node:child_process';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
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
let tmux: TmuxBackend;
let mc: Mc;

beforeEach(async () => {
  repo = await realpath(await mkdtemp(join(tmpdir(), 'mc-clirepo-')));
  home = await realpath(await mkdtemp(join(tmpdir(), 'mc-clihome-')));
  const sh = (...a: string[]) => execFileSync('git', a, { cwd: repo });
  sh('init', '-q', '-b', 'main');
  sh('config', 'user.email', 't@t');
  sh('config', 'user.name', 't');
  await writeFile(join(repo, 'a.txt'), 'a');
  sh('add', '.');
  sh('commit', '-q', '-m', 'init');
  tmux = new TmuxBackend({ socket: `mc-clitest-${process.pid}-${Date.now()}` });
  mc = new Mc({
    store: new Store(openDb()),
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

const run = async (...argv: string[]) => {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runCli(argv, mc, { out: (t) => out.push(t), err: (t) => err.push(t) });
  const text = out.join('\n');
  return { code, text, json: text.startsWith('{') || text.startsWith('[') ? JSON.parse(text) : undefined, err: err.join('\n') };
};

test('help and unknown commands', async () => {
  expect((await run()).text).toContain('mc spawn');
  const r = await run('wat');
  expect(r.code).toBe(1);
  expect(r.err).toContain('unknown command: wat');
});

test('a full session through the command line', async () => {
  const added = await run('project', 'add', repo, '--mode', 'no-mistakes');
  expect(added.json).toMatchObject({ path: repo, deliveryMode: 'no-mistakes' });
  expect((await run('project', 'list')).json).toHaveLength(1);

  const mission = (await run('mission', 'new', '--project', repo, '--type', 'build', '--goal', 'Add login')).json;
  expect(mission).toMatchObject({ status: 'planning', type: 'build' });

  const spawned = (await run('spawn', '--mission', mission.id, '--kind', 'ship', '--title', 'login form', '--harness', 'fake', '--brief', 'first job')).json;
  expect(spawned.agentId).toMatch(/^pilot-/);

  const deadline = Date.now() + 6000;
  let status;
  do {
    status = (await run('status', spawned.agentId)).json;
    if (status.screen.includes('got: first job') && status.verdict.state === 'idle') break;
    await new Promise((r) => setTimeout(r, 50));
  } while (Date.now() < deadline);
  expect(status.verdict.state).toBe('idle');

  expect((await run('send', spawned.agentId, '--text', 'second')).json).toEqual({ ok: true });
  expect((await run('status')).json).toHaveLength(1);
  expect((await run('mission', 'show', mission.id.slice(0, 8))).json.tasks).toHaveLength(1);
  const ev = (await run('events')).json;
  expect(ev.events.map((e: { kind: string }) => e.kind)).toEqual(['spawned']);
  expect(ev.ack).toBe(`mc events --ack ${ev.next}`);
  expect((await run('events')).json.events).toHaveLength(1);
  expect((await run('events', '--ack', String(ev.next))).json).toMatchObject({ events: [], acknowledged: ev.next, ack: null });
  expect((await run('events', '--ack', '999')).err).toContain('cannot acknowledge 999');
  expect((await run('status', '--attention')).json[0].attention).toMatch(/finished: review its diff/);

  expect((await run('teardown', spawned.agentId)).json).toMatchObject({ ok: true });
  expect((await run('status')).json).toEqual([]);
  expect((await run('harnesses')).json).toBeInstanceOf(Array);
});

test('errors are reported on stderr with exit code 1', async () => {
  const cases: string[][] = [
    ['project', 'add'],
    ['project', 'add', home],
    ['mission', 'new', '--project', repo, '--type', 'build'],
    ['mission', 'new', '--project', repo, '--type', 'weird', '--goal', 'x'],
    ['spawn', '--mission', 'nope', '--kind', 'ship', '--title', 't', '--harness', 'fake'],
    ['status', 'nope'],
    ['send', 'nope', '--text', 'x'],
    ['teardown', 'nope'],
    ['spawn', '--bogus'],
  ];
  for (const argv of cases) {
    const r = await run(...argv);
    expect(r.code, argv.join(' ')).toBe(1);
    expect(r.err, argv.join(' ')).toMatch(/^error: /);
  }
});

test('watch --once records events, and a second long-running watcher is refused', async () => {
  const project = (await run('project', 'add', repo)).json;
  const mission = (await run('mission', 'new', '--project', project.id, '--type', 'build', '--goal', 'g')).json;
  const spawned = (await run('spawn', '--mission', mission.id, '--kind', 'ship', '--title', 't', '--harness', 'fake', '--brief', 'job')).json;
  const deadline = Date.now() + 6000;
  while (Date.now() < deadline && (await run('status', spawned.agentId)).json.verdict.state !== 'idle') {
    await new Promise((r) => setTimeout(r, 50));
  }
  const once = await run('watch', '--once');
  expect(once.json.map((e: { kind: string }) => e.kind)).toEqual(['finished']);

  const ctl = new AbortController();
  const first = runCli(['watch', '--interval', '20'], mc, { out: () => {}, err: () => {}, signal: ctl.signal });
  await new Promise((r) => setTimeout(r, 150));
  const second = await run('watch', '--interval', '20');
  expect(second.code).toBe(1);
  expect(second.err).toContain('already running');
  ctl.abort();
  expect(await first).toBe(0);
  // The lock is released: a new watcher can start and stop.
  const ctl2 = new AbortController();
  const again = runCli(['watch', '--interval', '20'], mc, { out: () => {}, err: () => {}, signal: ctl2.signal });
  await new Promise((r) => setTimeout(r, 100));
  ctl2.abort();
  expect(await again).toBe(0);
});

test('a stale watcher lock from a dead process is replaced', async () => {
  const { writeFile: write, mkdir } = await import('node:fs/promises');
  await mkdir(home, { recursive: true });
  await write(join(home, 'watch.pid'), '999999');
  const ctl = new AbortController();
  const w = runCli(['watch', '--interval', '20'], mc, { out: () => {}, err: () => {}, signal: ctl.signal });
  await new Promise((r) => setTimeout(r, 100));
  ctl.abort();
  expect(await w).toBe(0);
});
