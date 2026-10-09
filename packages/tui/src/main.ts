#!/usr/bin/env -S node --disable-warning=ExperimentalWarning
import { homedir } from 'node:os';
import { join } from 'node:path';
import { render } from './render.js';
import { openReadOnly, takeSnapshot } from './snapshot.js';

const home = process.env.MC_HOME ?? join(homedir(), '.masterchief');
const args = process.argv.slice(2);
const once = args.includes('--once') || !process.stdout.isTTY;
const color = !process.env.NO_COLOR && !args.includes('--no-color') && (process.stdout.isTTY || args.includes('--color'));
const num = (flag: string) => {
  const i = args.indexOf(flag);
  return i >= 0 ? Number(args[i + 1]) : undefined;
};

async function frame(showAll: boolean): Promise<string[]> {
  const width = num('--width') ?? process.stdout.columns ?? 100;
  const height = num('--height') ?? process.stdout.rows ?? 30;
  const store = openReadOnly(home);
  if (!store) return [`No MasterChief database at ${join(home, 'mc.db')}.`, 'Run mc project add <path> first, or set MC_HOME.'];
  return render(await takeSnapshot(home, store), { width, height, color: !!color, showAll });
}

if (args.includes('--help')) {
  process.stdout.write('mc-tui [--once] [--width N] [--height N] [--no-color]\n  Live view of the fleet in $MC_HOME. Keys: q quit, r refresh, a toggle finished missions.\n');
} else if (once) {
  process.stdout.write(`${(await frame(true)).join('\n')}\n`);
} else {
  let showAll = false;
  let drawing = false;
  const draw = async () => {
    if (drawing) return;
    drawing = true;
    try {
      const lines = await frame(showAll);
      process.stdout.write(`\x1b[H${lines.map((l) => `${l}\x1b[K`).join('\n')}\x1b[J`);
    } catch (err) {
      process.stdout.write(`\x1b[H\x1b[Jerror: ${(err as Error).message}`);
    } finally {
      drawing = false;
    }
  };
  const leave = () => {
    process.stdout.write('\x1b[?25h\x1b[?1049l');
    if (process.stdin.isTTY) process.stdin.setRawMode(false);
    process.exit(0);
  };
  process.stdout.write('\x1b[?1049h\x1b[?25l');
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (key: string) => {
    if (key === 'q' || key === '\x03') leave();
    if (key === 'a') showAll = !showAll;
    if (key === 'a' || key === 'r') void draw();
  });
  process.on('SIGTERM', leave);
  process.stdout.on('resize', () => void draw());
  setInterval(() => void draw(), 1000);
  await draw();
}
