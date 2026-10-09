import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, Store } from '@masterchief/core';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { COMMANDS } from './cli.js';
import { commanderInstructions } from './commander-instructions.js';
import { fakeHarness } from './fake-harness.js';
import type { Harness, HarnessPrepareOptions } from './harness.js';
import { Mc } from './mc.js';
import { TmuxBackend } from './tmux.js';
import { freshWorktrees } from './worktree-provider.js';

let home: string;
let store: Store;
let tmux: TmuxBackend;
let mc: Mc;
let stub: string;
let seen: HarnessPrepareOptions[];

const waitFor = async (fn: () => Promise<boolean> | boolean, ms = 6000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('timed out');
};

// Stands in for the compiled mc entrypoint: `watch` takes the lock like the real one, anything else echoes.
const STUB = `
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const args = process.argv.slice(2);
if (args[0] === 'watch') {
  const file = join(process.env.MC_HOME, 'watch.pid');
  writeFileSync(file, String(process.pid));
  process.on('SIGTERM', () => { rmSync(file, { force: true }); process.exit(0); });
  setInterval(() => {}, 1000);
} else {
  console.log('stub:' + args.join(' '));
}
`;

beforeEach(async () => {
  home = await realpath(await mkdtemp(join(tmpdir(), 'mc-cmdhome-')));
  stub = join(home, 'stub-cli.mjs');
  await writeFile(stub, STUB);
  store = new Store(openDb());
  tmux = new TmuxBackend({ socket: `mc-cmdtest-${process.pid}-${Date.now()}` });
  seen = [];
  const spy: Harness = {
    ...fakeHarness,
    prepare: async (opts) => {
      seen.push(opts);
      return fakeHarness.prepare(opts);
    },
  };
  mc = new Mc({ store, tmux, worktrees: freshWorktrees, home, cliPath: stub, extraEnv: { MC_TMUX_SOCKET: 'x' }, harnessFor: (id) => (id === 'fake' ? spy : fakeHarness) });
});
afterEach(async () => {
  await mc.stopWatcher().catch(() => undefined);
  await tmux.killServer();
  await rm(home, { recursive: true, force: true });
});

test('commander start writes its instructions and shim, launches a window and sends the startup prompt', async () => {
  const r = await mc.commanderStart({ harness: 'fake' });
  expect(r).toMatchObject({ agentId: 'commander', already: false, resumed: false });
  expect(readFileSync(join(home, 'commander', 'CLAUDE.md'), 'utf8')).toContain('# MasterChief Commander');
  expect(execFileSync(join(home, 'bin', 'mc'), ['hello', 'there'], { encoding: 'utf8' })).toBe('stub:hello there\n');

  const opts = seen[0]!;
  expect(opts).toMatchObject({ role: 'commander', cwd: join(home, 'commander'), permissionMode: 'default', resume: false });
  expect(opts.denyTools).toEqual(['Edit', 'Write', 'NotebookEdit']);
  expect(opts.allowTools).toContain('Bash(mc *)');

  await waitFor(async () => (await tmux.capture(r.endpoint, 50)).includes('got: Session start'));
  expect(store.getAgent('commander')).toMatchObject({ role: 'commander', permanent: true, harness: 'fake' });
});

test('commander start is idempotent while alive, resumes after its window dies, and --fresh does not resume', async () => {
  const first = await mc.commanderStart({ harness: 'fake' });
  expect(await mc.commanderStart({ harness: 'fake' })).toMatchObject({ already: true, endpoint: first.endpoint });
  expect(seen).toHaveLength(1);

  await tmux.destroy(first.endpoint);
  const second = await mc.commanderStart({ harness: 'fake' });
  expect(second).toMatchObject({ already: false, resumed: true });
  expect(seen[1]!.resume).toBe(true);
  expect(store.listAgents().filter((a) => a.role === 'commander')).toHaveLength(1);

  await tmux.destroy(second.endpoint!);
  expect(await mc.commanderStart({ harness: 'fake', fresh: true })).toMatchObject({ resumed: false });
});

test('commander stop retires it, and attach needs a running commander', async () => {
  expect(() => mc.attachCommand()).toThrow(/no commander is running/);
  const r = await mc.commanderStart({ harness: 'fake' });
  expect(mc.attachCommand()).toEqual(['tmux', '-L', expect.stringContaining('mc-cmdtest'), 'select-window', '-t', r.endpoint, ';', 'attach-session', '-t', 'mc']);
  expect((await mc.commanderStatus()).verdict).not.toBeNull();
  await mc.commanderStop();
  expect(await tmux.status(r.endpoint)).toBe('missing');
  expect((await mc.commanderStatus()).agent).toBeNull();
  await expect(mc.commanderStop()).rejects.toThrow(/no commander/);
});

test('starting the commander also starts the background watcher once, and it can be stopped', async () => {
  expect(await mc.watchStatus()).toEqual({ running: false });
  await mc.commanderStart({ harness: 'fake' });
  const s = await mc.watchStatus();
  expect(s.running).toBe(true);
  expect(await mc.ensureWatcherBackground()).toMatchObject({ running: true, started: false, pid: s.pid });
  expect(await mc.stopWatcher()).toEqual({ stopped: true });
  expect(await mc.watchStatus()).toEqual({ running: false });
  expect(await mc.stopWatcher()).toEqual({ stopped: false });
  expect(existsSync(join(home, 'watch.log'))).toBe(true);
});

test('the instructions mention only commands that exist', () => {
  const text = commanderInstructions({ home: '/h' });
  const mentioned = new Set([...text.matchAll(/`mc ([a-z]+)/g)].map((m) => m[1]!));
  expect(mentioned.size).toBeGreaterThan(8);
  for (const cmd of mentioned) expect(COMMANDS, `mc ${cmd}`).toContain(cmd);
  expect(text).toContain('/h/config/dispatch.md');
});
