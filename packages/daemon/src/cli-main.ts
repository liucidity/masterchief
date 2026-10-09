#!/usr/bin/env -S node --disable-warning=ExperimentalWarning
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { openDb, Store } from '@masterchief/core';
import { runCli } from './cli.js';
import './claude.js';
import { Mc } from './mc.js';
import { TmuxBackend } from './tmux.js';
import { freshWorktrees } from './worktree-provider.js';

const home = process.env.MC_HOME ?? join(homedir(), '.masterchief');
mkdirSync(home, { recursive: true });
const mc = new Mc({
  store: new Store(openDb(join(home, 'mc.db'))),
  tmux: new TmuxBackend({ socket: process.env.MC_TMUX_SOCKET }),
  worktrees: freshWorktrees,
  home,
  cliPath: fileURLToPath(import.meta.url),
  extraEnv: process.env.MC_TMUX_SOCKET ? { MC_TMUX_SOCKET: process.env.MC_TMUX_SOCKET } : {},
});
process.exitCode = await runCli(process.argv.slice(2), mc, {
  out: (t) => process.stdout.write(`${t}\n`),
  err: (t) => process.stderr.write(`${t}\n`),
});
