import { execFileSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, Store } from '@masterchief/core';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { fakeHarness } from './fake-harness.js';
import { Mc } from './mc.js';
import { TmuxBackend } from './tmux.js';
import { freshWorktrees } from './worktree-provider.js';

let repo: string;
let home: string;
let store: Store;
let tmux: TmuxBackend;
let mc: Mc;
let ghLog: string;
const git = (cwd: string, ...a: string[]) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { cwd, encoding: 'utf8' }).trim();

const waitFor = async (fn: () => Promise<boolean> | boolean, ms = 8000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('timed out');
};
const idle = (ref: string) => waitFor(async () => (await mc.status(ref)).verdict.state === 'idle');
let marks = 0;
/** Make the scripted pilot run a shell command in its worktree, and wait for it to finish. */
const doThis = async (ref: string, cmd: string) => {
  await idle(ref);
  const n = ++marks;
  // The quotes keep the marker out of the echoed command line, so only the command's output matches.
  await mc.send(ref, { text: `do: ${cmd}; echo mc'done'-${n}` });
  await waitFor(async () => (await mc.status(ref, { lines: 200 })).screen.includes(`mcdone-${n}`));
  await idle(ref);
};

beforeEach(async () => {
  repo = await realpath(await mkdtemp(join(tmpdir(), 'mc-mrepo-')));
  home = await realpath(await mkdtemp(join(tmpdir(), 'mc-mhome-')));
  git(repo, 'init', '-q', '-b', 'main');
  await writeFile(join(repo, 'a.txt'), 'a\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'init');
  store = new Store(openDb());
  tmux = new TmuxBackend({ socket: `mc-mission-${process.pid}-${Date.now()}` });
  ghLog = join(home, 'gh.log');
  const bin = join(home, 'gh-stub');
  await writeFile(bin, `#!/bin/sh\nprintf '%s\\n' "$*" >> '${ghLog}'\necho https://example.test/pr/7\n`);
  await chmod(bin, 0o755);
  mc = new Mc({ store, tmux, worktrees: freshWorktrees, home, ghCommand: bin, enterDelayMs: 20, harnessIds: () => ['fake'], harnessFor: () => fakeHarness });
  await mkdir(join(home, 'config'), { recursive: true });
  await writeFile(join(home, 'config', 'roles.json'), JSON.stringify({ global: { pilot: { harness: 'fake' }, sentinel: { harness: 'fake' } } }));
});
afterEach(async () => {
  await tmux.killServer();
  await rm(repo, { recursive: true, force: true });
  await rm(home, { recursive: true, force: true });
});

const build = async (mode: 'local-only' | 'direct-pr' | 'no-mistakes' = 'local-only') => {
  const project = await mc.addProject({ path: repo, mode });
  const mission = mc.newMission({ project: project.id, type: 'build', goal: 'Add the feature file' });
  const pilot = await mc.spawn({ missionId: mission.id, kind: 'ship', title: 'add feature file', brief: 'start', trust: false });
  return { project, mission, pilot };
};
const COMMIT = "echo feature > feature.txt && git add . && git -c user.email=t@t -c user.name=t commit -q -m 'add feature'";

test('a local-only Build mission: plan, pilot, review gate, land, cleanup, finish', async () => {
  const { mission, pilot } = await build('local-only');
  await doThis(pilot.agentId, COMMIT);

  const w = mc.watcher();
  expect((await w.tick()).map((e) => e.kind)).toContain('finished');

  await expect(mc.land(pilot.agentId)).rejects.toThrow(/review required.*latest verdict: none/);
  mc.review(pilot.agentId, { verdict: 'reject', notes: 'needs a test' });
  await expect(mc.land(pilot.agentId)).rejects.toThrow(/latest verdict: reject/);
  mc.review(pilot.agentId, { verdict: 'approve', notes: 'looks right' });

  const landed = await mc.land(pilot.agentId);
  expect(landed).toMatchObject({ mode: 'local-only', merged: true });
  expect(await readFile(join(repo, 'feature.txt'), 'utf8')).toBe('feature\n');
  expect(git(repo, 'rev-parse', 'HEAD')).toBe(landed.sha);
  expect(store.listEvents().map((e) => e.kind)).toContain('landed');

  expect(() => mc.finishMission(mission.id)).toThrow(/live agents/);
  await mc.teardown(pilot.agentId);
  expect(existsSync(pilot.worktree)).toBe(false);
  expect(git(repo, 'branch', '--list', 'mc/*')).toBe('');
  expect(mc.finishMission(mission.id).status).toBe('done');
  expect(store.listReviews(mission.id).map((r) => r.verdict)).toEqual(['reject', 'approve']);
});

test('landing refuses dirty worktrees, empty branches, a moved default branch and busy checkouts', async () => {
  const { pilot } = await build('local-only');
  await idle(pilot.agentId);
  mc.review(pilot.agentId, { verdict: 'approve', notes: 'ok' });
  await expect(mc.land(pilot.agentId)).rejects.toThrow(/nothing to land/);

  await doThis(pilot.agentId, 'echo wip > wip.txt');
  await expect(mc.land(pilot.agentId)).rejects.toThrow(/uncommitted changes/);
  await doThis(pilot.agentId, `git add . && git -c user.email=t@t -c user.name=t commit -q -m wip`);

  await writeFile(join(repo, 'other.txt'), 'x');
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'main moved');
  await expect(mc.land(pilot.agentId)).rejects.toThrow(/cannot fast-forward .* rebase/);

  await doThis(pilot.agentId, 'git -c user.email=t@t -c user.name=t rebase -q main');
  git(repo, 'checkout', '-q', '-b', 'side');
  await expect(mc.land(pilot.agentId)).rejects.toThrow(/checkout is on side, not main/);
  git(repo, 'checkout', '-q', 'main');
  await writeFile(join(repo, 'a.txt'), 'dirty\n');
  await expect(mc.land(pilot.agentId)).rejects.toThrow(/uncommitted changes/);
  git(repo, 'checkout', '-q', '--', 'a.txt');
  expect(await mc.land(pilot.agentId)).toMatchObject({ merged: true });
});

test('a direct-pr Build mission pushes the branch, opens the PR, and teardown accepts pushed work', async () => {
  const origin = join(home, 'origin.git');
  git(home, 'init', '-q', '--bare', origin);
  git(repo, 'remote', 'add', 'origin', origin);
  git(repo, 'push', '-q', 'origin', 'main');
  const { pilot } = await build('direct-pr');
  await doThis(pilot.agentId, COMMIT);
  await expect(mc.teardown(pilot.agentId)).rejects.toThrow(/not pushed/);

  mc.review(pilot.agentId, { verdict: 'approve', notes: 'fine' });
  const r = await mc.land(pilot.agentId, { title: 'Add feature file' });
  expect(r).toMatchObject({ mode: 'direct-pr', pushed: true, pr: 'https://example.test/pr/7' });
  expect(git(origin, 'branch', '--list', pilot.branch).trim()).toContain(pilot.branch);
  const args = (await readFile(ghLog, 'utf8')).trim();
  expect(args).toContain('pr create --base main --head ' + pilot.branch + ' --title Add feature file');

  expect(git(repo, 'show', 'HEAD:a.txt')).toBe('a');
  await mc.teardown(pilot.agentId);
  expect(existsSync(pilot.worktree)).toBe(false);
});

test('direct-pr landing needs an origin remote and reports a failed pull request clearly', async () => {
  const { pilot } = await build('direct-pr');
  await doThis(pilot.agentId, COMMIT);
  mc.review(pilot.agentId, { verdict: 'approve', notes: 'ok' });
  await expect(mc.land(pilot.agentId)).rejects.toThrow(/no origin remote/);

  const origin = join(home, 'origin.git');
  git(home, 'init', '-q', '--bare', origin);
  git(repo, 'remote', 'add', 'origin', origin);
  mc = new Mc({ store, tmux, worktrees: freshWorktrees, home, ghCommand: '/bin/false', harnessFor: () => fakeHarness });
  await expect(mc.land(pilot.agentId)).rejects.toThrow(/branch was pushed, but opening the pull request failed/);
});

test('reviews apply to ship tasks and need notes', async () => {
  const { pilot, mission } = await build();
  expect(() => mc.review(pilot.agentId, { verdict: 'approve', notes: ' ' })).toThrow(/needs notes/);
  const sentinel = await mc.spawn({ missionId: mission.id, kind: 'sentinel', title: 's', trust: false });
  expect(() => mc.review(sentinel.agentId, { verdict: 'approve', notes: 'x' })).toThrow(/only ship tasks/);
  await expect(mc.land(sentinel.agentId)).rejects.toThrow(/only ship tasks/);
});

test('an Investigate mission: parallel sentinels write reports, findings are recorded, a build follows', async () => {
  const project = await mc.addProject({ path: repo });
  const mission = mc.newMission({ project: project.id, type: 'investigate', goal: 'why is checkout slow' });
  const a = await mc.spawn({ missionId: mission.id, kind: 'sentinel', title: 'hypothesis: n+1 query', brief: 'probe', trust: false });
  const b = await mc.spawn({ missionId: mission.id, kind: 'sentinel', title: 'hypothesis: cold cache', brief: 'probe', trust: false });
  expect(a.worktree).not.toBe(b.worktree);
  expect(a.branch).toBe('');

  const report = (t: { taskId: string }) => join(home, 'data', t.taskId, 'report.md');
  await doThis(a.agentId, `echo 'N+1 confirmed: 214 queries per checkout' > ${report(a)}`);
  await doThis(b.agentId, `echo 'cache is warm, not the cause' > ${report(b)}`);
  expect(await readFile(report(a), 'utf8')).toContain('N+1 confirmed');
  expect(git(a.worktree, 'status', '--porcelain')).toBe('');

  expect(() => mc.addFinding({ mission: mission.id, claim: 'x', evidence: ' ', confidence: 0.5 })).toThrow(/claim and evidence/);
  expect(() => mc.addFinding({ mission: mission.id, claim: 'x', evidence: 'y', confidence: 2 })).toThrow(/0 to 1/);
  mc.addFinding({ mission: mission.id, claim: 'Checkout issues an N+1 query', evidence: 'report of ' + a.agentId + ': 214 queries', confidence: 0.9 });
  expect(mc.listFindings(mission.id.slice(0, 8))).toHaveLength(1);

  await mc.teardown(a.agentId);
  await mc.teardown(b.agentId);
  expect(mc.finishMission(mission.id).status).toBe('done');

  const followUp = mc.newMission({ project: project.id, type: 'build', goal: 'Fix the N+1 query found in the investigation' });
  const fix = await mc.spawn({ missionId: followUp.id, kind: 'ship', title: 'batch the queries', trust: false });
  expect(store.getAgent(fix.agentId)?.role).toBe('pilot');
  expect(store.listFindings(mission.id)).toHaveLength(1);
});

test('finishing a mission refuses unfinished tasks unless aborted', async () => {
  const { mission, pilot } = await build();
  await mc.teardown(pilot.agentId, { outcome: 'failed' });
  expect(mc.finishMission(mission.id).status).toBe('done');
  const other = mc.newMission({ project: store.listProjects()[0]!.id, type: 'build', goal: 'second' });
  store.createTask({ missionId: other.id, title: 'never started', dependsOn: [] });
  expect(() => mc.finishMission(other.id)).toThrow(/unfinished tasks/);
  expect(mc.finishMission(other.id, { abort: true }).status).toBe('aborted');
});
