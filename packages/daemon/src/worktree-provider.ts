import type { Workspace } from '@masterchief/core';
import { createWorkspace, pruneStale, removeWorkspace, type CreateOptions } from './workspace.js';

/**
 * Where agent worktrees come from. Release hands a worktree back rather than
 * deleting it, so a pool-backed provider can reuse it later.
 */
export interface WorktreeProvider {
  acquire(opts: CreateOptions): Promise<Workspace>;
  release(repoPath: string, ws: Workspace): Promise<void>;
  /** Drop worktrees whose agent is no longer live. Returns the agent ids removed. */
  prune(repoPath: string, liveAgentIds: Set<string>): Promise<string[]>;
}

/** Creates a fresh worktree on acquire and deletes it on release. */
export const freshWorktrees: WorktreeProvider = {
  acquire: createWorkspace,
  release: removeWorkspace,
  prune: pruneStale,
};
