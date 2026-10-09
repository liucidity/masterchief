#!/usr/bin/env -S node --disable-warning=ExperimentalWarning
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, Store } from '@masterchief/core';
import { runCli } from './cli.js';
import './harnesses.js';
import { Mc } from './mc.js';
import { TmuxBackend } from './tmux.js';
import { freshWorktrees } from './worktree-provider.js';

const socket = process.env.MC_TMUX_SOCKET;

/** Build the mc service for one home. A second mate's home gets its own tmux session. */
function build(home: string, session = process.env.MC_TMUX_SESSION): Mc {
  mkdirSync(home, { recursive: true });
  return new Mc({
    store: new Store(openDb(join(home, 'mc.db'))),
    tmux: new TmuxBackend({ socket, session }),
    worktrees: freshWorktrees,
    home,
    cliPath: fileURLToPath(import.meta.url),
    guardPath: fileURLToPath(new URL('./guard-main.js', import.meta.url)),
    extraEnv: { ...(socket ? { MC_TMUX_SOCKET: socket } : {}), ...(session ? { MC_TMUX_SESSION: session } : {}) },
    openHome: build,
  });
}

const mc = build(process.env.MC_HOME ?? join(homedir(), '.masterchief'));
process.exitCode = await runCli(process.argv.slice(2), mc, {
  out: (t) => process.stdout.write(`${t}\n`),
  err: (t) => process.stderr.write(`${t}\n`),
});
