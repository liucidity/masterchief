import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { freshWorktrees, type WorktreeProvider } from './worktree-provider.js';

let repo: string;
const sh = (...a: string[]) => execFileSync('git', a, { cwd: repo, encoding: 'utf8' }).trim();

beforeEach(async () => {
  repo = await mkdtemp(join(tmpdir(), 'mc-wp-'));
  sh('init', '-q', '-b', 'main');
  sh('config', 'user.email', 't@t');
  sh('config', 'user.name', 't');
  await writeFile(join(repo, 'a.txt'), 'a');
  sh('add', '.');
  sh('commit', '-q', '-m', 'init');
});
afterEach(() => rm(repo, { recursive: true, force: true }));

const provider: WorktreeProvider = freshWorktrees;

test('acquire, release and prune work through the provider interface', async () => {
  const a = await provider.acquire({ repoPath: repo, missionId: 'm1', agentId: 'p-1', access: 'rw' });
  const b = await provider.acquire({ repoPath: repo, missionId: 'm1', agentId: 's-1', access: 'ro' });
  expect(existsSync(a.worktreePath)).toBe(true);
  expect(b.branch).toBe('');

  await provider.release(repo, a);
  expect(existsSync(a.worktreePath)).toBe(false);

  expect(await provider.prune(repo, new Set())).toEqual(['s-1']);
  expect(existsSync(b.worktreePath)).toBe(false);
});
