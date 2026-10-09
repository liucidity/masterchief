import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { registerHarness, type Harness, type HarnessLaunch, type HarnessPrepareOptions } from './harness.js';

export const CLAUDE_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];

/** Hook events written to the per-agent log, one per line: `<gen> <epoch-seconds> <event>`. */
export const HOOK_EVENTS = {
  UserPromptSubmit: 'prompt',
  Stop: 'stop',
  StopFailure: 'stop-failure',
  SessionEnd: 'session-end',
} as const;

const SAFE_PATH = /^[A-Za-z0-9_@%+=:,./~-]+$/;

export function hookLogPath(stateDir: string, agentId: string): string {
  return join(stateDir, `${agentId}.hooks.log`);
}

function hookCommand(log: string, gen: string, event: string): string {
  // Paths are checked against SAFE_PATH, so single quoting here cannot be broken out of.
  return `printf '%s %s %s\\n' '${gen}' "$(date +%s)" '${event}' >> '${log}'`;
}

/** Per-agent settings that report turn lifecycle through the hook log. */
export function claudeHookSettings(log: string, gen: string): object {
  const hooks: Record<string, unknown> = {};
  for (const [name, event] of Object.entries(HOOK_EVENTS)) {
    hooks[name] = [{ hooks: [{ type: 'command', command: hookCommand(log, gen, event) }] }];
  }
  return { hooks };
}

function claudeConfigFile(): string {
  return join(process.env.CLAUDE_CONFIG_DIR ?? homedir(), '.claude.json');
}

/**
 * Mark directories as trusted so a fresh worktree does not stop at Claude's
 * interactive workspace-trust dialog, which an autonomous pane cannot answer.
 * Refuses to touch an explicit decline.
 */
export async function registerClaudeTrust(dirs: string[], configFile = claudeConfigFile()): Promise<void> {
  let config: { projects?: Record<string, Record<string, unknown>> } = {};
  try {
    config = JSON.parse(await readFile(configFile, 'utf8')) as typeof config;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  config.projects ??= {};
  for (const dir of dirs) {
    const entry = (config.projects[dir] ??= {});
    entry.hasTrustDialogAccepted = true;
  }
  await mkdir(dirname(configFile), { recursive: true });
  const tmp = `${configFile}.mc-${process.pid}-${Date.now()}`;
  await writeFile(tmp, JSON.stringify(config, null, 2));
  await rename(tmp, configFile);
}

export const claudeHarness: Harness = {
  id: 'claude',
  efforts: CLAUDE_EFFORTS,
  semanticBusy: true,
  exitText: '/exit',
  interruptKeys: ['Escape'],

  validate(model, effort) {
    if (model != null && !/^[A-Za-z0-9][A-Za-z0-9._:\[\]-]*$/.test(model)) return `invalid model: ${model}`;
    if (effort != null && !CLAUDE_EFFORTS.includes(effort)) {
      return `invalid effort for claude: ${effort} (use ${CLAUDE_EFFORTS.join(', ')})`;
    }
    return null;
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
    await writeFile(settingsFile, JSON.stringify(claudeHookSettings(log, gen), null, 2));
    if (opts.trust !== false) await registerClaudeTrust([opts.cwd], opts.trust?.configFile);

    const command = ['claude', '--settings', settingsFile, '--permission-mode', opts.permissionMode ?? 'bypassPermissions'];
    if (opts.model) command.push('--model', opts.model);
    if (opts.effort) command.push('--effort', opts.effort);
    if (opts.appendSystemPrompt) command.push('--append-system-prompt', opts.appendSystemPrompt);
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
