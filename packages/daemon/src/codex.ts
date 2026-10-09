import { randomUUID } from 'node:crypto';
import { appendFile, mkdir } from 'node:fs/promises';
import { hookLogPath } from './claude.js';
import { registerHarness, type Harness, type HarnessLaunch, type HarnessPrepareOptions } from './harness.js';

export const CODEX_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
const SAFE_PATH = /^[A-Za-z0-9_@%+=:,./~-]+$/;

/**
 * Launch recipe for the Codex CLI, from the flags firstmate verified on codex-cli
 * 0.15x. It could not be run here (codex is not installed), so it is unverified live.
 *
 * Codex has no turn-start hook a pane worker can use, so MasterChief records the
 * prompt itself, and Codex's `notify` program records the end of each turn. Codex's
 * hook layer is disabled: an untrusted hook raises a review modal an agent cannot
 * answer. That also means no PreToolUse guard, so a Codex agent is isolated only by
 * its worktree.
 */
export const codexHarness: Harness = {
  id: 'codex',
  efforts: CODEX_EFFORTS,
  semanticBusy: true,
  recordsSends: true,
  exitText: '/quit',
  interruptKeys: ['Escape'],

  validate(model, effort) {
    if (model != null && !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(model)) return `invalid model: ${model}`;
    if (effort != null && !CODEX_EFFORTS.includes(effort)) return `invalid effort for codex: ${effort} (use ${CODEX_EFFORTS.join(', ')})`;
    return null;
  },

  async prepare(opts: HarnessPrepareOptions): Promise<HarnessLaunch> {
    const problem = this.validate(opts.model, opts.effort);
    if (problem) throw new Error(problem);
    if (opts.permissionMode && opts.permissionMode !== 'bypassPermissions') {
      throw new Error(`codex supports only the bypassPermissions mode here, not ${opts.permissionMode}`);
    }
    if (opts.guardCommand) {
      // Hooks are off for Codex, so a guard cannot run. Ignore it rather than pretend.
    }
    const log = hookLogPath(opts.stateDir, opts.agentId);
    if (!SAFE_PATH.test(log)) throw new Error(`unsafe path for a codex launch: ${log}`);
    const gen = randomUUID();
    await mkdir(opts.stateDir, { recursive: true });
    if (opts.initialPrompt) await appendFile(log, `${gen} ${Math.floor(Date.now() / 1000)} prompt\n`);

    const notify = ['bash', '-c', `printf '%s %s %s\\n' '${gen}' "$(date +%s)" 'stop' >> '${log}'`];
    const command = ['codex'];
    if (opts.model) command.push('--model', opts.model);
    if (opts.effort) command.push('-c', `model_reasoning_effort=${JSON.stringify(opts.effort)}`);
    command.push('--dangerously-bypass-approvals-and-sandbox', '--disable', 'hooks', '-c', `notify=${JSON.stringify(notify)}`);
    if (opts.initialPrompt) command.push(opts.initialPrompt);
    return { command, env: { MC_AGENT_ID: opts.agentId, MC_ROLE: opts.role }, gen, hookLog: log };
  },
};

registerHarness(codexHarness);
