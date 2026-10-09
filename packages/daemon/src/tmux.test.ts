import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { TmuxBackend } from './tmux.js';

let tmux: TmuxBackend;
let dir: string;

const waitFor = async (fn: () => Promise<boolean>, ms = 5000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('timed out');
};

beforeEach(async () => {
  tmux = new TmuxBackend({ socket: `mc-test-${process.pid}-${Date.now()}` });
  dir = await realpath(await mkdtemp(join(tmpdir(), 'mc-tmux-')));
});
afterEach(async () => {
  await tmux.killServer();
  await rm(dir, { recursive: true, force: true });
});

test('creates a window in the cwd with env, and captures its screen', async () => {
  const ep = await tmux.create({
    name: 'pilot-1',
    cwd: dir,
    env: { MC_AGENT_ID: 'pilot-1' },
    command: ['sh', '-c', 'pwd; echo id=$MC_AGENT_ID; sleep 30'],
  });
  await waitFor(async () => (await tmux.capture(ep)).includes('id=pilot-1'));
  const screen = await tmux.capture(ep);
  expect(screen).toContain(dir);
  expect(await tmux.status(ep)).toBe('alive');
});

test('sends text and keys to the running program', async () => {
  const ep = await tmux.create({ name: 'echo', cwd: dir, command: ['cat'] });
  await tmux.sendText(ep, 'hello world');
  await tmux.sendKeys(ep, 'Enter');
  await waitFor(async () => (await tmux.capture(ep)).split('\n').filter((l) => l.includes('hello world')).length >= 2);
  await tmux.sendKeys(ep, 'C-c');
  await waitFor(async () => (await tmux.status(ep)) === 'dead');
});

test('a finished program reads as dead and keeps its output; a destroyed window reads as missing', async () => {
  const ep = await tmux.create({ name: 'short', cwd: dir, command: ['sh', '-c', 'echo bye'] });
  await waitFor(async () => (await tmux.status(ep)) === 'dead');
  expect(await tmux.capture(ep)).toContain('bye');
  await tmux.destroy(ep);
  expect(await tmux.status(ep)).toBe('missing');
  await tmux.destroy(ep);
});

test('lists windows and handles concurrent creates', async () => {
  const eps = await Promise.all(
    ['a', 'b', 'c'].map((name) => tmux.create({ name, cwd: dir, command: ['sleep', '30'] })),
  );
  expect(new Set(eps).size).toBe(3);
  const list = await tmux.list();
  expect(list.filter((w) => ['a', 'b', 'c'].includes(w.name))).toHaveLength(3);
});

test('multi-line text arrives as a single paste', async () => {
  const ep = await tmux.create({ name: 'paste', cwd: dir, command: ['cat'] });
  await tmux.sendText(ep, 'line one\nline two');
  await tmux.sendKeys(ep, 'Enter');
  await waitFor(async () => {
    const s = await tmux.capture(ep);
    return s.includes('line one') && s.includes('line two');
  });
});
