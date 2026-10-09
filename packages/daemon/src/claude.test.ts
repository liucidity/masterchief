import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { classifyAgent, lastHookEvent } from './busy.js';
import { claudeHarness, registerClaudeTrust } from './claude.js';
import { getHarness, listHarnesses } from './harness.js';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'mc-claude-'));
});
afterEach(() => rm(dir, { recursive: true, force: true }));

const prep = (extra = {}) =>
  claudeHarness.prepare({ agentId: 'pilot-1', role: 'pilot', cwd: join(dir, 'wt'), stateDir: join(dir, 'state'), trust: false, ...extra });

test('claude is registered and validates model and effort', () => {
  expect(listHarnesses()).toContain('claude');
  expect(getHarness('claude')).toBe(claudeHarness);
  expect(() => getHarness('nope')).toThrow(/unknown harness/);
  expect(claudeHarness.validate('opus', 'high')).toBeNull();
  expect(claudeHarness.validate('claude-opus-5-5', null)).toBeNull();
  expect(claudeHarness.validate('--bad', null)).toMatch(/invalid model/);
  expect(claudeHarness.validate(null, 'extreme')).toMatch(/invalid effort/);
});

test('prepare builds the command, env and a settings file with all four hooks', async () => {
  const l = await prep({ model: 'opus', effort: 'high', appendSystemPrompt: 'be brief' });
  expect(l.command.slice(0, 1)).toEqual(['claude']);
  expect(l.command).toEqual(expect.arrayContaining(['--model', 'opus', '--effort', 'high', '--permission-mode', 'acceptEdits', '--allowedTools', 'Bash', '--append-system-prompt', 'be brief']));
  expect(l.env).toMatchObject({ MC_AGENT_ID: 'pilot-1', MC_ROLE: 'pilot' });
  const settings = JSON.parse(await readFile(l.command[l.command.indexOf('--settings') + 1]!, 'utf8'));
  expect(Object.keys(settings.hooks).sort()).toEqual(['Notification', 'PreToolUse', 'SessionEnd', 'Stop', 'StopFailure', 'UserPromptSubmit']);
  expect((await prep()).gen).not.toBe(l.gen);
});

test('prepare rejects paths that could break out of the hook command and invalid options', async () => {
  await expect(prep({ cwd: `${dir}/it's` })).rejects.toThrow(/unsafe path/);
  await expect(prep({ effort: 'extreme' })).rejects.toThrow(/invalid effort/);
});

test('trust registration merges into an existing config and creates a missing one', async () => {
  const file = join(dir, '.claude.json');
  await registerClaudeTrust(['/a'], file);
  await writeFile(file, JSON.stringify({ theme: 'dark', projects: { '/old': { x: 1 } } }));
  await registerClaudeTrust(['/a', '/b'], file);
  const c = JSON.parse(await readFile(file, 'utf8'));
  expect(c.theme).toBe('dark');
  expect(c.projects['/old']).toEqual({ x: 1 });
  expect(c.projects['/a'].hasTrustDialogAccepted).toBe(true);
  expect(c.projects['/b'].hasTrustDialogAccepted).toBe(true);
});

test('the generated hook commands write lines that classify busy, idle and dead', async () => {
  const l = await prep();
  const settings = JSON.parse(await readFile(l.command[l.command.indexOf('--settings') + 1]!, 'utf8'));
  const fire = (hook: string) => execFileSync('sh', ['-c', settings.hooks[hook][0].hooks[0].command]);
  const verdict = () => classifyAgent({ harness: claudeHarness, endpoint: 'alive', hookLog: l.hookLog, gen: l.gen });

  expect((await verdict())).toMatchObject({ state: 'unknown', source: 'no-events-yet' });
  fire('UserPromptSubmit');
  expect(await verdict()).toMatchObject({ state: 'busy', source: 'hooks', event: 'prompt' });
  fire('Stop');
  expect(await verdict()).toMatchObject({ state: 'idle', event: 'stop' });
  fire('UserPromptSubmit');
  fire('StopFailure');
  expect(await verdict()).toMatchObject({ state: 'idle', event: 'stop-failure' });
  fire('SessionEnd');
  expect(await verdict()).toMatchObject({ state: 'dead', event: 'session-end' });
});

test('classification: a gone process wins, other incarnations are ignored, and gaps are unknown', async () => {
  const l = await prep();
  const log = l.hookLog!;
  await writeFile(log, `other-gen 100 prompt\n${l.gen} 101 stop\n${l.gen} bad stop\ngarbage\n${l.gen} 102 mystery\n`);
  expect(await lastHookEvent(log, l.gen)).toEqual({ event: 'stop', ts: 101 });
  expect(await lastHookEvent(log, 'someone-else')).toBeUndefined();

  const base = { harness: claudeHarness, hookLog: log, gen: l.gen };
  expect(await classifyAgent({ ...base, endpoint: 'missing' })).toMatchObject({ state: 'dead', source: 'endpoint-missing' });
  expect(await classifyAgent({ ...base, endpoint: 'dead' })).toMatchObject({ state: 'dead', source: 'endpoint-exited' });
  expect(await classifyAgent({ ...base, endpoint: 'alive', gen: 'new-incarnation' })).toMatchObject({ state: 'unknown' });
  expect(await classifyAgent({ ...base, endpoint: 'alive', hookLog: join(dir, 'nope.log') })).toMatchObject({ state: 'unknown' });
  expect(await classifyAgent({ harness: claudeHarness, endpoint: 'alive', hookLog: null, gen: null })).toMatchObject({ state: 'unknown', source: 'no-hook-record' });
  expect(await classifyAgent({ harness: { ...claudeHarness, semanticBusy: false }, endpoint: 'alive', hookLog: log, gen: l.gen })).toMatchObject({ state: 'unknown', source: 'no-semantic-source' });
});

test('a guard command joins the PreToolUse hook for every tool, and unsafe arguments are refused', async () => {
  const l = await prep({ guardCommand: ['/usr/bin/node', '/opt/guard.js', '--role', 'pilot', '--worktree', '/w/t'] });
  const settings = JSON.parse(await readFile(l.command[l.command.indexOf('--settings') + 1]!, 'utf8'));
  expect(settings.hooks.PreToolUse).toHaveLength(1);
  expect(settings.hooks.PreToolUse[0].matcher).toBe('*');
  const commands = settings.hooks.PreToolUse[0].hooks.map((h: { command: string }) => h.command);
  expect(commands).toHaveLength(2);
  expect(commands[0]).toContain("'working'");
  expect(commands[1]).toBe("'/usr/bin/node' '/opt/guard.js' '--role' 'pilot' '--worktree' '/w/t'");
  const without = JSON.parse(await readFile((await prep()).command.at(2)!, 'utf8'));
  expect(without.hooks.PreToolUse[0].hooks).toHaveLength(1);
  await expect(prep({ guardCommand: ['/bin/node', "it's"] })).rejects.toThrow(/unsafe argument/);
});

test('permission prompts and questions mark the agent as waiting, and the next tool call marks it working again', async () => {
  const l = await prep();
  const settings = JSON.parse(await readFile(l.command[l.command.indexOf('--settings') + 1]!, 'utf8'));
  expect(settings.hooks.Notification.map((n: { matcher: string }) => n.matcher)).toEqual(['permission_prompt', 'elicitation_dialog', 'agent_needs_input']);
  const fire = (cmd: string) => execFileSync('sh', ['-c', cmd]);
  const verdict = () => classifyAgent({ harness: claudeHarness, endpoint: 'alive', hookLog: l.hookLog, gen: l.gen });
  fire(settings.hooks.UserPromptSubmit[0].hooks[0].command);
  expect(await verdict()).toMatchObject({ state: 'busy', event: 'prompt' });
  fire(settings.hooks.Notification[0].hooks[0].command);
  expect(await verdict()).toMatchObject({ state: 'waiting', event: 'waiting' });
  fire(settings.hooks.PreToolUse[0].hooks[0].command);
  expect(await verdict()).toMatchObject({ state: 'busy', event: 'working' });
  fire(settings.hooks.Stop[0].hooks[0].command);
  expect(await verdict()).toMatchObject({ state: 'idle' });
});

test('permission posture: acceptEdits with allow rules by default, bypass only when asked, and explicit tools win', async () => {
  const dflt = (await prep()).command;
  expect(dflt).toEqual(expect.arrayContaining(['--permission-mode', 'acceptEdits', '--allowedTools']));
  expect(dflt).not.toContain('bypassPermissions');
  const bypass = (await prep({ permissionMode: 'bypassPermissions' })).command;
  expect(bypass).toEqual(expect.arrayContaining(['--permission-mode', 'bypassPermissions']));
  expect(bypass).not.toContain('--allowedTools');
  const custom = (await prep({ allowTools: ['Read'] })).command;
  expect(custom.slice(custom.indexOf('--allowedTools'), custom.indexOf('--allowedTools') + 2)).toEqual(['--allowedTools', 'Read']);
});

test('a long hook log is read from its tail without mistaking a cut line for an event', async () => {
  const l = await prep();
  const lines = [`${l.gen} 1 prompt`];
  for (let i = 0; i < 4000; i++) lines.push(`${l.gen} ${2 + i} working`);
  lines.push(`${l.gen} 9000 stop`);
  await writeFile(l.hookLog!, lines.join('\n') + '\n');
  expect((await readFile(l.hookLog!)).length).toBeGreaterThan(40_000);
  expect(await lastHookEvent(l.hookLog!, l.gen)).toEqual({ event: 'stop', ts: 9000 });
  // The final line is cut so only a fragment of an event name remains at the very end of a read window.
  await writeFile(l.hookLog!, lines.slice(0, 3000).join('\n') + `\n${l.gen} 5000 sto`);
  expect(await lastHookEvent(l.hookLog!, l.gen)).toEqual({ event: 'working', ts: 2 + 2998 });
});
