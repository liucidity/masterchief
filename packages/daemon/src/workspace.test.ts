import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { agentEnv, createWorkspace, pruneStale, removeWorkspace } from './workspace.js';

let repo: string;
const sh = (...a: string[]) => execFileSync('git', a, { cwd: repo, encoding: 'utf8' }).trim();

beforeEach(async () => {
  repo = await mkdtemp(join(tmpdir(), 'mc-repo-'));
  sh('init', '-q', '-b', 'main');
  sh('config', 'user.email', 't@t');
  sh('config', 'user.name', 't');
  await writeFile(join(repo, 'a.txt'), 'a');
  sh('add', '.');
  sh('commit', '-q', '-m', 'init');
});
afterEach(() => rm(repo, { recursive: true, force: true }));

test('writer gets its own branch and worktree', async () => {
  const ws = await createWorkspace({ repoPath: repo, missionId: 'm1', agentId: 'eng-1', access: 'rw' });
  expect(ws.branch).toBe('mc/m1/eng-1');
  expect(existsSync(join(ws.worktreePath, 'a.txt'))).toBe(true);
  expect(sh('branch', '--list', 'mc/m1/eng-1')).toContain('mc/m1/eng-1');
  expect(sh('status', '--porcelain')).toBe('');
});

test('read-only agent gets a detached checkout', async () => {
  const ws = await createWorkspace({ repoPath: repo, missionId: 'm1', agentId: 'inv-1', access: 'ro' });
  expect(ws.branch).toBe('');
  expect(execFileSync('git', ['branch', '--show-current'], { cwd: ws.worktreePath, encoding: 'utf8' }).trim()).toBe('');
});

test('parallel agents are isolated from each other', async () => {
  const [a, b] = await Promise.all(
    ['eng-1', 'eng-2'].map((agentId) =>
      createWorkspace({ repoPath: repo, missionId: 'm1', agentId, access: 'rw' }),
    ),
  );
  await writeFile(join(a!.worktreePath, 'a.txt'), 'changed by 1');
  expect(execFileSync('cat', [join(b!.worktreePath, 'a.txt')], { encoding: 'utf8' })).toBe('a');
});

test('remove deletes worktree and branch', async () => {
  const ws = await createWorkspace({ repoPath: repo, missionId: 'm1', agentId: 'eng-1', access: 'rw' });
  await removeWorkspace(repo, ws);
  expect(existsSync(ws.worktreePath)).toBe(false);
  expect(sh('branch', '--list', 'mc/m1/eng-1')).toBe('');
});

test('prune removes worktrees of dead agents and keeps live ones', async () => {
  await createWorkspace({ repoPath: repo, missionId: 'm1', agentId: 'live', access: 'rw' });
  const dead = await createWorkspace({ repoPath: repo, missionId: 'm1', agentId: 'dead', access: 'rw' });
  expect(await pruneStale(repo, new Set(['live']))).toEqual(['dead']);
  expect(existsSync(dead.worktreePath)).toBe(false);
  expect(sh('branch', '--list', 'mc/m1/dead')).toBe('');
  expect(sh('branch', '--list', 'mc/m1/live')).toContain('live');
});

test('prune recovers after a crash that deleted the directory', async () => {
  const ws = await createWorkspace({ repoPath: repo, missionId: 'm1', agentId: 'eng-1', access: 'rw' });
  await rm(ws.worktreePath, { recursive: true });
  await pruneStale(repo, new Set());
  expect(sh('worktree', 'list')).not.toContain('eng-1');
  expect(sh('branch', '--list', 'mc/m1/eng-1')).toBe('');
  const again = await createWorkspace({ repoPath: repo, missionId: 'm1', agentId: 'eng-1', access: 'rw' });
  expect(existsSync(again.worktreePath)).toBe(true);
});

test('rejects unsafe identifiers', async () => {
  await expect(
    createWorkspace({ repoPath: repo, missionId: 'm1', agentId: '../evil', access: 'rw' }),
  ).rejects.toThrow(/unsafe identifier/);
});

test('agent env gives each slot a distinct port block and temp dir', async () => {
  const ws = await createWorkspace({ repoPath: repo, missionId: 'm1', agentId: 'eng-1', access: 'rw' });
  const e0 = agentEnv(ws, 0);
  const e1 = agentEnv(ws, 1);
  expect(Number(e1.MC_PORT_BASE) - Number(e0.MC_PORT_BASE)).toBe(20);
  expect(e0.TMPDIR.startsWith(ws.worktreePath)).toBe(true);
});
