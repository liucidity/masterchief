import { randomUUID } from 'node:crypto';
import type { Stats } from 'node:fs';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { registerHarness, type ComposerState, type Harness, type HarnessLaunch, type HarnessPrepareOptions } from './harness.js';

/** Tools a crew member may use without asking. The guard hook still screens every call. */
export const CREW_TOOLS = ['Bash', 'Read', 'Glob', 'Grep', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit'];

export const CLAUDE_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];

/** Hook events written to the per-agent log, one per line: `<gen> <epoch-seconds> <event>`. */
export const HOOK_EVENTS = {
  UserPromptSubmit: 'prompt',
  Stop: 'stop',
  StopFailure: 'stop-failure',
  SessionEnd: 'session-end',
} as const;

/** Notification types that mean the agent is waiting on a person. */
export const WAITING_NOTIFICATIONS = ['permission_prompt', 'elicitation_dialog', 'agent_needs_input'];

const SAFE_PATH = /^[A-Za-z0-9_@%+=:,./~-]+$/;

export function hookLogPath(stateDir: string, agentId: string): string {
  return join(stateDir, `${agentId}.hooks.log`);
}

function hookCommand(log: string, gen: string, event: string): string {
  // Paths are checked against SAFE_PATH, so single quoting here cannot be broken out of.
  return `printf '%s %s %s\\n' '${gen}' "$(date +%s)" '${event}' >> '${log}'`;
}

/** Per-agent settings that report turn lifecycle and prompts through the hook log. */
export function claudeHookSettings(log: string, gen: string, guard?: string[]): object {
  const hooks: Record<string, unknown> = {};
  for (const [name, event] of Object.entries(HOOK_EVENTS)) {
    hooks[name] = [{ hooks: [{ type: 'command', command: hookCommand(log, gen, event) }] }];
  }
  // One entry per notification type, so each matcher is a plain literal.
  hooks.Notification = WAITING_NOTIFICATIONS.map((type) => ({
    matcher: type,
    hooks: [{ type: 'command', command: hookCommand(log, gen, 'waiting') }],
  }));
  // A tool call means the agent is working again. The guard, when present, screens the same call.
  const preToolUse: { type: string; command: string }[] = [{ type: 'command', command: hookCommand(log, gen, 'working') }];
  if (guard) {
    for (const part of guard) {
      if (!SAFE_PATH.test(part)) throw new Error(`unsafe argument for a claude guard hook: ${part}`);
    }
    preToolUse.push({ type: 'command', command: guard.map((p) => `'${p}'`).join(' ') });
  }
  hooks.PreToolUse = [{ matcher: '*', hooks: preToolUse }];
  return { hooks };
}

/**
 * Claude draws its input box between two full-width rules, with a prompt marker on the first
 * line. A dialog has no such box, so anything unexpected reads as not ready. The empty-session
 * placeholder suggestion counts as empty.
 */
export function claudeComposerState(screen: string): ComposerState {
  const lines = screen.split('\n');
  const rules = lines.flatMap((l, i) => (/^─{8,}\s*$/.test(l) ? [i] : []));
  if (rules.length < 2) return 'unknown';
  const [top, bottom] = rules.slice(-2) as [number, number];
  const box = lines
    .slice(top + 1, bottom)
    .map((l) => l.replace(/^\s*[❯>]\s?/, '').trim())
    .join('\n')
    .trim();
  if (!box || /^Try ".*"$/.test(box)) return 'empty';
  return 'typing';
}

function claudeConfigFile(): string {
  return join(process.env.CLAUDE_CONFIG_DIR ?? homedir(), '.claude.json');
}

interface ClaudeConfig {
  projects?: Record<string, Record<string, unknown>>;
  [key: string]: unknown;
}

export interface ConfigEditOptions {
  attempts?: number;
  /** Runs after the new file is written and before it is swapped in. Lets tests play a racing writer. */
  onBeforeCommit?: () => Promise<void> | void;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Edit Claude's config file without losing a write made by Claude itself. Claude does not honour any
 * lock of ours, so this is optimistic: read, change, write a temp file, and only swap it in if the
 * original is untouched, otherwise start again from what Claude wrote. The file keeps its mode.
 * Returns whether anything was written.
 */
export async function editClaudeConfig(file: string, mutate: (config: ClaudeConfig) => boolean, opts: ConfigEditOptions = {}): Promise<boolean> {
  const attempts = opts.attempts ?? 8;
  const signature = (st: Stats | undefined) => (st ? `${st.ino}:${st.size}:${st.mtimeMs}` : 'missing');
  for (let attempt = 0; attempt < attempts; attempt++) {
    const before = await stat(file).catch(() => undefined);
    let config: ClaudeConfig = {};
    if (before) {
      try {
        config = JSON.parse(await readFile(file, 'utf8')) as ClaudeConfig;
      } catch {
        // Claude may be part way through a write. Never overwrite what we cannot read.
        await sleep(25 * (attempt + 1));
        continue;
      }
    }
    if (!mutate(config)) return false;
    await mkdir(dirname(file), { recursive: true });
    const tmp = `${file}.mc-${process.pid}-${randomUUID().slice(0, 8)}`;
    await writeFile(tmp, JSON.stringify(config, null, 2), { mode: before ? before.mode & 0o777 : 0o600 });
    await opts.onBeforeCommit?.();
    if (signature(await stat(file).catch(() => undefined)) !== signature(before)) {
      await rm(tmp, { force: true });
      continue;
    }
    await rename(tmp, file);
    return true;
  }
  throw new Error(`could not update ${file}: it kept changing or could not be read`);
}

/**
 * Mark directories as trusted so a fresh worktree does not stop at Claude's interactive
 * workspace-trust dialog, which an autonomous pane cannot answer. Skips the write when they
 * are all trusted already.
 */
export async function registerClaudeTrust(dirs: string[], configFile = claudeConfigFile(), opts: ConfigEditOptions = {}): Promise<boolean> {
  return editClaudeConfig(
    configFile,
    (config) => {
      config.projects ??= {};
      let changed = false;
      for (const dir of dirs) {
        const entry = (config.projects[dir] ??= {});
        if (entry.hasTrustDialogAccepted !== true) {
          entry.hasTrustDialogAccepted = true;
          changed = true;
        }
      }
      return changed;
    },
    opts,
  );
}

/** Where MasterChief keeps agent worktrees; only entries under here are ever forgotten. */
const OWN_WORKTREE = /\/\.mc\/wt\/[^/]+$/;

/** Forget the trust entry for a worktree MasterChief made, once the worktree is gone. */
export async function unregisterClaudeTrust(dirs: string[], configFile = claudeConfigFile(), opts: ConfigEditOptions = {}): Promise<boolean> {
  const own = dirs.filter((d) => OWN_WORKTREE.test(d));
  if (!own.length) return false;
  return editClaudeConfig(
    configFile,
    (config) => {
      let changed = false;
      for (const dir of own) {
        if (config.projects && dir in config.projects) {
          delete config.projects[dir];
          changed = true;
        }
      }
      return changed;
    },
    opts,
  );
}

export const claudeHarness: Harness = {
  id: 'claude',
  efforts: CLAUDE_EFFORTS,
  semanticBusy: true,
  composerState: claudeComposerState,
  exitText: '/exit',
  interruptKeys: ['Escape'],

  validate(model, effort) {
    if (model != null && !/^[A-Za-z0-9][A-Za-z0-9._:\[\]-]*$/.test(model)) return `invalid model: ${model}`;
    if (effort != null && !CLAUDE_EFFORTS.includes(effort)) {
      return `invalid effort for claude: ${effort} (use ${CLAUDE_EFFORTS.join(', ')})`;
    }
    return null;
  },

  async forget(opts) {
    if (opts.trust !== false) await unregisterClaudeTrust([opts.cwd], opts.trust?.configFile);
  },

  async prepare(opts: HarnessPrepareOptions): Promise<HarnessLaunch> {
    const problem = this.validate(opts.model, opts.effort);
    if (problem) throw new Error(problem);
    const log = hookLogPath(opts.stateDir, opts.agentId);
    for (const p of [log, opts.cwd]) {
      if (!SAFE_PATH.test(p)) throw new Error(`unsafe path for a claude launch: ${p}`);
    }
    const gen = randomUUID();
    await mkdir(opts.stateDir, { recursive: true });
    const settingsFile = join(opts.stateDir, `${opts.agentId}.settings.json`);
    await writeFile(settingsFile, JSON.stringify(claudeHookSettings(log, gen, opts.guardCommand), null, 2));
    if (opts.trust !== false) await registerClaudeTrust([opts.cwd], opts.trust?.configFile);

    // Autonomous crew run in acceptEdits mode with explicit allow rules. The bypassPermissions flag
    // raises a one-time, machine-wide consent dialog no agent can answer, so it is opt-in.
    const mode = opts.permissionMode ?? 'acceptEdits';
    const allow = opts.allowTools ?? (mode === 'bypassPermissions' ? [] : CREW_TOOLS);
    const command = ['claude', '--settings', settingsFile, '--permission-mode', mode];
    if (opts.resume) command.push('--continue');
    if (allow.length) command.push('--allowedTools', ...allow);
    if (opts.denyTools?.length) command.push('--disallowedTools', ...opts.denyTools);
    if (opts.model) command.push('--model', opts.model);
    if (opts.effort) command.push('--effort', opts.effort);
    if (opts.appendSystemPrompt) command.push('--append-system-prompt', opts.appendSystemPrompt);
    if (opts.initialPrompt) command.push('--', opts.initialPrompt);
    return {
      command,
      env: {
        MC_AGENT_ID: opts.agentId,
        MC_ROLE: opts.role,
        // Predicted-prompt ghost text looks like typed input in a screen capture.
        CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION: 'false',
      },
      gen,
      hookLog: log,
    };
  },
};

registerHarness(claudeHarness);
