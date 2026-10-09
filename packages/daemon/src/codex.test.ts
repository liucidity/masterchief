import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, Store } from '@masterchief/core';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { classifyAgent } from './busy.js';
import { codexHarness } from './codex.js';
import { getHarness, listHarnesses } from './harness.js';
import './harnesses.js';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'mc-codex-'));
});
afterEach(() => rm(dir, { recursive: true, force: true }));

const prep = (extra = {}) => codexHarness.prepare({ agentId: 'pilot-1', role: 'pilot', cwd: join(dir, 'wt'), stateDir: join(dir, 'state'), ...extra });

test('both built-in harnesses are registered', () => {
  expect(listHarnesses().sort()).toEqual(['claude', 'codex']);
  expect(getHarness('codex')).toBe(codexHarness);
  expect(openDb()).toBeTruthy();
  expect(new Store(openDb())).toBeTruthy();
});

test('validation covers model, effort and permission mode', async () => {
  expect(codexHarness.validate('gpt-5.6-luna', 'max')).toBeNull();
  expect(codexHarness.validate('--x', null)).toMatch(/invalid model/);
  expect(codexHarness.validate(null, 'turbo')).toMatch(/invalid effort for codex/);
  await expect(prep({ permissionMode: 'plan' })).rejects.toThrow(/only the bypassPermissions mode/);
});

test('the launch command carries model, effort, notify and the brief', async () => {
  const l = await prep({ model: 'gpt-5.6-luna', effort: 'high', initialPrompt: 'do the thing' });
  expect(l.command.slice(0, 5)).toEqual(['codex', '--model', 'gpt-5.6-luna', '-c', 'model_reasoning_effort="high"']);
  expect(l.command).toEqual(expect.arrayContaining(['--dangerously-bypass-approvals-and-sandbox', '--disable', 'hooks']));
  expect(l.command.at(-1)).toBe('do the thing');
  expect(l.env).toMatchObject({ MC_AGENT_ID: 'pilot-1', MC_ROLE: 'pilot' });
});

test('the brief marks the agent busy, and the notify program marks the end of the turn', async () => {
  const l = await prep({ initialPrompt: 'go' });
  const verdict = () => classifyAgent({ harness: codexHarness, endpoint: 'alive', hookLog: l.hookLog, gen: l.gen });
  expect(await verdict()).toMatchObject({ state: 'busy', event: 'prompt' });

  const notifyArg = l.command.find((a) => a.startsWith('notify='))!;
  expect(notifyArg).toBeTruthy();
  const argv = JSON.parse(notifyArg.slice('notify='.length)) as string[];
  execFileSync(argv[0]!, [...argv.slice(1), '{"type":"agent-turn-complete"}']);
  expect(await verdict()).toMatchObject({ state: 'idle', event: 'stop' });
});

test('without a brief the agent starts unknown rather than busy', async () => {
  const l = await prep();
  expect(await classifyAgent({ harness: codexHarness, endpoint: 'alive', hookLog: l.hookLog, gen: l.gen })).toMatchObject({ state: 'unknown' });
});
