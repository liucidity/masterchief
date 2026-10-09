import { appendFile, mkdir, readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { Workspace, WorkspaceAccess } from '@masterchief/core';
import { git } from './git.js';

const WT_DIR = '.mc/wt';
const PORT_BLOCK = 20;

export interface CreateOptions {
  repoPath: string;
  missionId: string;
  agentId: string;
  access: WorkspaceAccess;
  baseRef?: string;
}

const safe = (s: string) => {
  if (!/^[A-Za-z0-9._-]+$/.test(s)) throw new Error(`unsafe identifier: ${s}`);
  return s;
};

export const worktreePath = (repoPath: string, agentId: string) =>
  join(resolve(repoPath), WT_DIR, safe(agentId));

export const branchName = (missionId: string, agentId: string) =>
  `mc/${safe(missionId)}/${safe(agentId)}`;

const EXCLUDED = ['.mc/', '.mc-tmp/'];

async function excludeMcDir(repoPath: string): Promise<void> {
  const file = join(await git(repoPath, 'rev-parse', '--absolute-git-dir'), 'info', 'exclude');
  const current = await readFile(file, 'utf8').catch(() => '');
  const lines = current.split('\n');
  const missing = EXCLUDED.filter((e) => !lines.includes(e));
  if (missing.length) {
    await mkdir(join(file, '..'), { recursive: true });
    await appendFile(file, `${current.endsWith('\n') || !current ? '' : '\n'}${missing.join('\n')}\n`);
  }
}

/** Writers get their own branch; read-only agents get a detached checkout. */
export async function createWorkspace(opts: CreateOptions): Promise<Workspace> {
  const { repoPath, missionId, agentId, access, baseRef = 'HEAD' } = opts;
  const path = worktreePath(repoPath, agentId);
  const baseSha = await git(repoPath, 'rev-parse', baseRef);
  await excludeMcDir(repoPath);
  let branch = '';
  if (access === 'rw') {
    branch = branchName(missionId, agentId);
    await git(repoPath, 'worktree', 'add', '-b', branch, path, baseSha);
  } else {
    await git(repoPath, 'worktree', 'add', '--detach', path, baseSha);
  }
  return { id: agentId, worktreePath: path, branch, baseSha, access };
}

export async function removeWorkspace(repoPath: string, ws: Workspace): Promise<void> {
  await git(repoPath, 'worktree', 'remove', '--force', ws.worktreePath).catch(async () => {
    await rm(ws.worktreePath, { recursive: true, force: true });
    await git(repoPath, 'worktree', 'prune');
  });
  if (ws.branch) await git(repoPath, 'branch', '-D', ws.branch).catch(() => undefined);
}

/** Worktrees under .mc/wt whose agent is not live. Read-only. */
export async function listStale(repoPath: string, liveAgentIds: Set<string>): Promise<{ agentId: string; path: string; branch: string }[]> {
  const root = join(resolve(repoPath), WT_DIR) + '/';
  const listing = await git(repoPath, 'worktree', 'list', '--porcelain');
  const out: { agentId: string; path: string; branch: string }[] = [];
  for (const block of listing.split('\n\n')) {
    const lines = block.split('\n');
    const path = lines.find((l) => l.startsWith('worktree '))?.slice(9);
    if (!path?.startsWith(root)) continue;
    const agentId = path.slice(root.length);
    if (liveAgentIds.has(agentId)) continue;
    const branch = lines.find((l) => l.startsWith('branch '))?.slice('branch refs/heads/'.length) ?? '';
    out.push({ agentId, path, branch });
  }
  return out;
}

/**
 * Remove worktrees and mc/* branches whose agent is no longer known, and
 * prune registrations whose directory is gone. Returns the agent ids removed.
 */
export async function pruneStale(repoPath: string, liveAgentIds: Set<string>): Promise<string[]> {
  await git(repoPath, 'worktree', 'prune');
  const root = join(resolve(repoPath), WT_DIR) + '/';
  const listing = await git(repoPath, 'worktree', 'list', '--porcelain');
  const removed: string[] = [];
  for (const block of listing.split('\n\n')) {
    const lines = block.split('\n');
    const path = lines.find((l) => l.startsWith('worktree '))?.slice(9);
    if (!path?.startsWith(root)) continue;
    const agentId = path.slice(root.length);
    if (liveAgentIds.has(agentId)) continue;
    const branch = lines.find((l) => l.startsWith('branch '))?.slice('branch refs/heads/'.length);
    await git(repoPath, 'worktree', 'remove', '--force', path);
    if (branch?.startsWith('mc/')) await git(repoPath, 'branch', '-D', branch).catch(() => undefined);
    removed.push(agentId);
  }
  // A crash can delete a directory but leave its branch behind.
  const checkedOut = new Set(
    (await git(repoPath, 'worktree', 'list', '--porcelain'))
      .split('\n')
      .filter((l) => l.startsWith('branch '))
      .map((l) => l.slice('branch refs/heads/'.length)),
  );
  const refs = await git(repoPath, 'for-each-ref', '--format=%(refname:short)', 'refs/heads/mc/');
  for (const ref of refs.split('\n').filter(Boolean)) {
    const agentId = ref.split('/').pop()!;
    if (!checkedOut.has(ref) && !liveAgentIds.has(agentId)) {
      await git(repoPath, 'branch', '-D', ref);
      if (!removed.includes(agentId)) removed.push(agentId);
    }
  }
  return removed;
}

/** Environment for an agent process: own temp dir and its own port block. */
export function agentEnv(ws: Workspace, slot: number, basePort = 41000): Record<string, string> {
  const first = basePort + slot * PORT_BLOCK;
  return {
    MC_AGENT_ID: ws.id,
    MC_WORKTREE: ws.worktreePath,
    MC_PORT_BASE: String(first),
    MC_PORT_END: String(first + PORT_BLOCK - 1),
    TMPDIR: join(ws.worktreePath, '.mc-tmp'),
  };
}
