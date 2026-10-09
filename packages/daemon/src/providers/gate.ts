import { isAbsolute, relative, resolve } from 'node:path';
import type { AgentRole } from '@masterchief/core';
import { WRITE_TOOLS, argPath, isPathTool } from './tools.js';
import type { Permissions, ToolGate } from './types.js';

const WRITER_ROLES: AgentRole[] = ['engineer', 'tester'];

export interface GateContext {
  role: AgentRole;
  worktreePath: string;
  permissions: Permissions;
}

const inside = (root: string, path: string) => {
  const rel = relative(resolve(root), resolve(root, path));
  return rel !== '..' && !rel.startsWith('../') && !isAbsolute(rel);
};

/**
 * Build the daemon's gate for one agent. Paths are checked lexically, so
 * symlinks and shell commands are not inspected here.
 */
export function createGate(ctx: GateContext): ToolGate {
  return ({ tool, args }) => {
    if (!ctx.permissions.tools.includes(tool)) {
      return { allow: false, reason: `tool "${tool}" is not permitted` };
    }
    if (WRITE_TOOLS.includes(tool) && !WRITER_ROLES.includes(ctx.role)) {
      return { allow: false, reason: `role "${ctx.role}" is read-only` };
    }
    if (isPathTool(tool)) {
      const path = argPath(args);
      if (path === undefined) return { allow: false, reason: `"${tool}" needs a path` };
      if (!inside(ctx.worktreePath, path)) {
        return { allow: false, reason: `path "${path}" is outside the worktree` };
      }
    }
    return { allow: true };
  };
}
