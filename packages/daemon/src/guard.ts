import { realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import type { AgentRole } from '@masterchief/core';

export interface GuardContext {
  role: AgentRole;
  worktree: string;
  /** Where a sentinel writes its report. Pilots do not need it. */
  reportDir?: string;
  /** Directory the tool call runs in. */
  cwd: string;
  env?: Record<string, string | undefined>;
}

export interface ToolCall {
  tool: string;
  input: Record<string, unknown>;
}

export type Decision = { allow: true } | { allow: false; reason: string };

const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
const READ_TOOLS = new Set(['Read', 'Glob', 'Grep', 'NotebookRead']);
/** Tools that start other agents or worktrees outside MasterChief's own bookkeeping. */
const DELEGATION_TOOLS = new Set(['Task', 'Agent', 'EnterWorktree', 'CronCreate', 'RemoteTrigger']);
const WRITING_COMMANDS = new Set(['rm', 'mv', 'cp', 'mkdir', 'rmdir', 'touch', 'chmod', 'chown', 'ln', 'tee', 'install', 'truncate', 'patch', 'rsync', 'unlink', 'shred']);
const SAFE_SINKS = new Set(['/dev/null', '/dev/stdout', '/dev/stderr']);
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash']);

/** Resolve a path through symlinks, even when its tail does not exist yet. */
export function canonical(path: string): string {
  const abs = resolve(path);
  const tail: string[] = [];
  let cur = abs;
  for (;;) {
    try {
      return join(realpathSync(cur), ...tail.reverse());
    } catch {
      const parent = dirname(cur);
      if (parent === cur) return abs;
      tail.push(basename(cur));
      cur = parent;
    }
  }
}

const within = (root: string, path: string) => {
  const rel = relative(canonical(root), canonical(path));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
};

function writeRoots(ctx: GuardContext): string[] {
  const env = ctx.env ?? {};
  const tmp = env.TMPDIR ? [env.TMPDIR] : [join(ctx.worktree, '.mc-tmp')];
  if (ctx.role === 'sentinel') return [...(ctx.reportDir ? [ctx.reportDir] : []), ...tmp, '/tmp'];
  return [ctx.worktree, ...tmp, '/tmp'];
}

function readRoots(ctx: GuardContext): string[] {
  return [ctx.worktree, ...(ctx.reportDir ? [ctx.reportDir] : [])];
}

const deny = (reason: string): Decision => ({ allow: false, reason });

/**
 * Split a shell command into simple commands, with arguments and redirection
 * targets separated. Honours quotes and backslashes; it is not a full shell parser.
 */
export function splitShell(input: string): { argv: string[]; redirects: string[] }[] {
  const commands: { argv: string[]; redirects: string[] }[] = [];
  let argv: string[] = [];
  let redirects: string[] = [];
  let tok = '';
  let has = false;
  let quote: '"' | "'" | null = null;
  let redirectNext = false;

  const flush = () => {
    if (!has) return;
    (redirectNext ? redirects : argv).push(tok);
    redirectNext = false;
    tok = '';
    has = false;
  };
  const endCommand = () => {
    flush();
    redirectNext = false;
    if (argv.length || redirects.length) commands.push({ argv, redirects });
    argv = [];
    redirects = [];
  };

  for (let i = 0; i < input.length; i++) {
    const c = input[i]!;
    if (quote) {
      if (c === quote) quote = null;
      else if (c === '\\' && quote === '"' && i + 1 < input.length) tok += input[++i];
      else tok += c;
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      has = true;
    } else if (c === '\\' && i + 1 < input.length) {
      tok += input[++i];
      has = true;
    } else if (c === '>') {
      // A leading file descriptor ("2>") or "&>" belongs to the redirect, not to an argument.
      if (!(has && (/^\d+$/.test(tok) || tok === '&'))) flush();
      tok = '';
      has = false;
      if (input[i + 1] === '>') i++;
      if (input[i + 1] === '&') {
        // "2>&1" duplicates a descriptor; it names no file.
        i++;
        while (/[\d-]/.test(input[i + 1] ?? '')) i++;
        redirectNext = false;
      } else {
        redirectNext = true;
      }
    } else if (c === ';' || c === '\n' || c === '|') {
      if (c === '|' && input[i + 1] === '|') i++;
      endCommand();
    } else if (c === '&' && input[i + 1] === '>') {
      flush();
      tok = '&';
      has = true;
    } else if (c === '&') {
      if (input[i + 1] === '&') i++;
      endCommand();
    } else if (c === ' ' || c === '\t') {
      flush();
    } else {
      tok += c;
      has = true;
    }
  }
  endCommand();
  return commands;
}

function expandVars(arg: string, env: Record<string, string | undefined>): string | undefined {
  if (/[`]|\$\(/.test(arg)) return undefined;
  let bad = false;
  const out = arg.replace(/\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?/g, (_m, name: string) => {
    const v = env[name];
    if (v === undefined) bad = true;
    return v ?? '';
  });
  return bad ? undefined : out;
}

function resolvePath(arg: string, cwd: string, env: Record<string, string | undefined>): string | undefined {
  const expanded = expandVars(arg, env);
  if (expanded === undefined) return undefined;
  if (expanded === '~' || expanded.startsWith('~/')) return join(env.HOME ?? '/nonexistent-home', expanded.slice(1));
  return resolve(cwd, expanded);
}

function checkCommand(argv: string[], redirects: string[], ctx: GuardContext, cwd: { value: string }, depth: number): Decision {
  const env: Record<string, string | undefined> = { ...(ctx.env ?? {}), MC_WORKTREE: ctx.worktree };
  const roots = writeRoots(ctx);
  const inRoots = (p: string, rs: string[]) => rs.some((r) => within(r, p));

  for (const target of redirects) {
    if (SAFE_SINKS.has(target)) continue;
    const p = resolvePath(target, cwd.value, env);
    if (p === undefined) return deny(`redirect target "${target}" cannot be resolved; use a plain path inside your worktree`);
    if (!inRoots(p, roots)) return deny(`writing to ${p} is outside your allowed area`);
  }

  // Skip leading VAR=value assignments.
  let i = 0;
  while (i < argv.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(argv[i]!)) i++;
  const args = argv.slice(i);
  if (!args.length) return { allow: true };
  const name = basename(args[0]!);

  if (['sudo', 'su', 'doas', 'pkexec'].includes(name)) return deny('privilege escalation is not allowed');

  if (name === 'cd' || name === 'pushd') {
    const target = args[1] ?? env.HOME ?? '';
    if (target === '-' || !target) return deny('cd needs an explicit path inside your worktree');
    const p = resolvePath(target, cwd.value, env);
    if (p === undefined) return deny(`cd target "${target}" cannot be resolved; use a plain path inside your worktree`);
    if (!within(ctx.worktree, p)) return deny(`cd to ${p} leaves your worktree (${ctx.worktree})`);
    cwd.value = p;
    return { allow: true };
  }

  if (SHELLS.has(name)) {
    const ci = args.indexOf('-c');
    if (ci > 0 && args[ci + 1] !== undefined) {
      if (depth >= 3) return deny('shell commands are nested too deeply to check');
      return checkBash(args[ci + 1]!, ctx, depth + 1, { value: cwd.value });
    }
    return { allow: true };
  }

  if (name === 'git') {
    for (let k = 1; k < args.length; k++) {
      const a = args[k]!;
      if ((a === '-C' || a === '--git-dir' || a === '--work-tree') && args[k + 1] !== undefined) {
        const p = resolvePath(args[k + 1]!, cwd.value, env);
        if (p === undefined || !within(ctx.worktree, p)) return deny(`git ${a} ${args[k + 1]} points outside your worktree`);
        k++;
      } else if (/^--(git-dir|work-tree)=/.test(a)) {
        const p = resolvePath(a.split('=')[1]!, cwd.value, env);
        if (p === undefined || !within(ctx.worktree, p)) return deny(`${a} points outside your worktree`);
      }
    }
    const sub = args.slice(1).find((a) => !a.startsWith('-') && !a.includes('/'));
    if (sub === 'worktree') return deny('managing git worktrees is the Commander\'s job');
    if (sub === 'push' && args.some((a) => a === '-f' || a === '--force' || a.startsWith('--force-with-lease') || a === '--mirror' || a === '--delete')) {
      return deny('force or destructive pushes are not allowed');
    }
    return { allow: true };
  }

  if (WRITING_COMMANDS.has(name) || (name === 'sed' && args.some((a) => /^-[a-zA-Z]*i/.test(a) || a.startsWith('--in-place')))) {
    for (const a of args.slice(1)) {
      if (a.startsWith('-') && a.length > 1) continue;
      if (!/[/~$.]/.test(a) && name !== 'rm' && name !== 'mkdir' && name !== 'touch') continue; // bare words like sed expressions
      const p = resolvePath(a, cwd.value, env);
      if (p === undefined) return deny(`path "${a}" for ${name} cannot be resolved; use a plain path inside your worktree`);
      if (!inRoots(p, roots)) return deny(`${name} on ${p} is outside your allowed area`);
    }
  }
  return { allow: true };
}

function checkBash(command: string, ctx: GuardContext, depth: number, cwd: { value: string }): Decision {
  for (const { argv, redirects } of splitShell(command)) {
    const d = checkCommand(argv, redirects, ctx, cwd, depth);
    if (!d.allow) return d;
  }
  return { allow: true };
}

const filePathOf = (input: Record<string, unknown>): string | undefined => {
  for (const key of ['file_path', 'path', 'notebook_path']) {
    if (typeof input[key] === 'string') return input[key] as string;
  }
  return undefined;
};

/** Decide whether one tool call may run. Pure apart from reading symlinks. */
export function evaluateToolCall(call: ToolCall, ctx: GuardContext): Decision {
  if (DELEGATION_TOOLS.has(call.tool)) {
    return deny(`${call.tool} is not available to crew members; ask the Commander to spawn work with mc`);
  }
  if (WRITE_TOOLS.has(call.tool) || READ_TOOLS.has(call.tool)) {
    const writing = WRITE_TOOLS.has(call.tool);
    const path = filePathOf(call.input);
    if (path === undefined) {
      // Glob and Grep default to the current directory.
      if (writing) return deny(`${call.tool} needs a path`);
      return within(ctx.worktree, ctx.cwd) ? { allow: true } : deny(`${call.tool} would run outside your worktree`);
    }
    const abs = resolve(ctx.cwd, path);
    const roots = writing ? writeRoots(ctx).filter((r) => r !== '/tmp') : readRoots(ctx);
    if (!roots.some((r) => within(r, abs))) {
      return deny(`${call.tool} on ${abs} is outside your allowed area (${roots.join(', ')})`);
    }
    return { allow: true };
  }
  if (call.tool === 'Bash') {
    const command = call.input.command;
    if (typeof command !== 'string') return deny('Bash needs a command string');
    return checkBash(command, ctx, 0, { value: ctx.cwd });
  }
  return { allow: true };
}
