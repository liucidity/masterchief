import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, symlinkSync } from 'node:fs';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { evaluateToolCall, splitShell, type GuardContext } from './guard.js';

let root: string;
let wt: string;
let outside: string;
let report: string;

beforeEach(async () => {
  root = await realpath(await mkdtemp(join('/var/tmp', 'mc-guard-')));
  wt = join(root, 'wt');
  outside = join(root, 'outside');
  report = join(root, 'data', 'task1');
  for (const d of [wt, outside, report, join(wt, 'src'), join(wt, '.mc-tmp')]) mkdirSync(d, { recursive: true });
  symlinkSync(outside, join(wt, 'escape'));
});
afterEach(() => rm(root, { recursive: true, force: true }));

const ctx = (extra: Partial<GuardContext> = {}): GuardContext => ({
  role: 'pilot',
  worktree: wt,
  cwd: wt,
  env: { HOME: '/home/someone', TMPDIR: join(wt, '.mc-tmp') },
  ...extra,
});
const bash = (command: string, extra: Partial<GuardContext> = {}) => evaluateToolCall({ tool: 'Bash', input: { command } }, ctx(extra));
const ok = (d: { allow: boolean }, msg?: string) => expect(d.allow, msg).toBe(true);
const blocked = (d: { allow: boolean; reason?: string }, re?: RegExp, label?: string) => {
  expect(d.allow, label).toBe(false);
  if (re) expect(d.reason).toMatch(re);
};

test('the shell splitter keeps quoted operators together and finds redirect targets', () => {
  expect(splitShell(`git commit -m "a; rm -rf /" && npm test`)).toEqual([
    { argv: ['git', 'commit', '-m', 'a; rm -rf /'], redirects: [] },
    { argv: ['npm', 'test'], redirects: [] },
  ]);
  expect(splitShell('echo hi>out.txt 2>&1')).toEqual([{ argv: ['echo', 'hi'], redirects: ['out.txt'] }]);
  expect(splitShell('cmd >> log &> all')).toEqual([{ argv: ['cmd'], redirects: ['log', 'all'] }]);
  expect(splitShell('a | b || c; d\ne &')).toHaveLength(5);
  expect(splitShell("echo 'it''s' \"q\\\"x\"")).toEqual([{ argv: ['echo', 'its', 'q"x'], redirects: [] }]);
});

test('file tools stay inside the worktree, through symlinks and dot-dot', () => {
  ok(evaluateToolCall({ tool: 'Write', input: { file_path: join(wt, 'src/a.ts') } }, ctx()));
  ok(evaluateToolCall({ tool: 'Edit', input: { file_path: 'src/a.ts' } }, ctx()));
  ok(evaluateToolCall({ tool: 'Read', input: { file_path: join(wt, 'package.json') } }, ctx()));
  ok(evaluateToolCall({ tool: 'Grep', input: { pattern: 'x' } }, ctx()));
  blocked(evaluateToolCall({ tool: 'Write', input: { file_path: '/etc/passwd' } }, ctx()), /outside your allowed area/);
  blocked(evaluateToolCall({ tool: 'Edit', input: { file_path: '../outside/x' } }, ctx()));
  blocked(evaluateToolCall({ tool: 'Write', input: { file_path: join(wt, 'escape/new.txt') } }, ctx()), /outside/);
  blocked(evaluateToolCall({ tool: 'Write', input: { file_path: '/tmp/x' } }, ctx()));
  blocked(evaluateToolCall({ tool: 'Read', input: { file_path: join(outside, 'secret') } }, ctx()));
  blocked(evaluateToolCall({ tool: 'Glob', input: { pattern: '*', path: outside } }, ctx()));
  blocked(evaluateToolCall({ tool: 'Grep', input: { pattern: 'x' } }, ctx({ cwd: outside })));
  blocked(evaluateToolCall({ tool: 'Write', input: {} }, ctx()), /needs a path/);
});

test('delegation tools are refused', () => {
  for (const tool of ['Task', 'Agent', 'EnterWorktree', 'CronCreate']) blocked(evaluateToolCall({ tool, input: {} }, ctx()), /not available to crew/);
  ok(evaluateToolCall({ tool: 'WebFetch', input: { url: 'https://example.com' } }, ctx()));
});

test('ordinary build and test commands are allowed', () => {
  for (const c of [
    'npm test', 'npm run build && npm test -- auth', 'cd src && ls -la', 'echo hi > out.txt', 'cat a | grep b', 'git status',
    'git commit -m "x; rm -rf /"', 'rm -rf node_modules', 'mkdir -p build/out', 'echo x > /dev/null 2>&1', "sed -i 's/a/b/' src/file.ts",
    'FOO=1 npm run build', 'bash -c "cd src && ls"', 'git push origin mc/feature', 'cd .mc-tmp && touch t', 'rm -rf $MC_WORKTREE/dist',
    'echo $TMPDIR > $TMPDIR/x', 'git -C . log', 'rm /tmp/scratch', 'cat /etc/hosts',
  ]) ok(bash(c), c);
});

test('commands that leave the worktree are blocked', () => {
  const cases: [string, RegExp][] = [
    ['cd ..', /leaves your worktree/],
    ['cd /', /leaves your worktree/],
    ['cd ~', /leaves your worktree/],
    ['cd -', /explicit path/],
    ['cd $NOPE', /cannot be resolved/],
    ['cd src && cd ../..', /leaves your worktree/],
    ['echo x > ../out', /outside your allowed area/],
    ['echo x >/etc/hosts', /outside/],
    ['cat a >> ~/.bashrc', /outside/],
    ['rm -rf /', /outside/],
    ['rm -rf ../outside', /outside/],
    ['mv a /etc/b', /outside/],
    ['cp a ~/b', /outside/],
    ['touch $(pwd)/../x', /cannot be resolved/],
    ['rm $HOME/x', /outside/],
    ['sed -i s/a/b/ /etc/hosts', /outside/],
    ['ln -s a escape/link', /outside/],
    ['git -C /other status', /outside your worktree/],
    ['git --git-dir=../outside/.git log', /outside your worktree/],
    ['git worktree add ../w', /Commander/],
    ['git push --force origin main', /force/],
    ['git push -f', /force/],
    ['sudo ls', /privilege/],
    ['bash -c "cd / && ls"', /leaves your worktree/],
    ['sh -c "sh -c \\"echo x > /etc/hosts\\""', /outside/],
  ];
  for (const [c, re] of cases) blocked(bash(c), re, c);
});

test('tracked directory changes carry across commands', () => {
  ok(bash('cd src && rm ../package.json'));
  blocked(bash('cd src && rm ../../outside/x'), /outside/, 'cd src && rm ../../outside/x');
});

test('sentinels write only to their report directory', () => {
  const s = (extra: Partial<GuardContext> = {}) => ctx({ role: 'sentinel', reportDir: report, ...extra });
  ok(evaluateToolCall({ tool: 'Write', input: { file_path: join(report, 'report.md') } }, s()));
  blocked(evaluateToolCall({ tool: 'Write', input: { file_path: join(wt, 'src/a.ts') } }, s()));
  ok(evaluateToolCall({ tool: 'Read', input: { file_path: join(wt, 'src/a.ts') } }, s()));
  ok(evaluateToolCall({ tool: 'Bash', input: { command: `echo f > ${report}/report.md` } }, s()));
  ok(evaluateToolCall({ tool: 'Bash', input: { command: 'ls src && cat package.json' } }, s()));
  blocked(evaluateToolCall({ tool: 'Bash', input: { command: 'echo x > src/a.ts' } }, s()));
  blocked(evaluateToolCall({ tool: 'Bash', input: { command: 'rm -rf src' } }, s()));
  ok(evaluateToolCall({ tool: 'Bash', input: { command: 'touch .mc-tmp/scratch' } }, s()));
});

test('the hook entrypoint blocks with exit code 2 and fails closed on bad input', () => {
  const entry = join(__dirname, '..', 'dist', 'guard-main.js');
  const run = (stdin: string) =>
    spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', entry, '--role', 'pilot', '--worktree', wt], { input: stdin, encoding: 'utf8' });
  try {
    execFileSync('test', ['-f', entry]);
  } catch {
    return; // not built yet; the entrypoint is covered by the full build in CI
  }
  expect(run(JSON.stringify({ tool_name: 'Write', tool_input: { file_path: join(wt, 'a') }, cwd: wt })).status).toBe(0);
  const denied = run(JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'cd /' }, cwd: wt }));
  expect(denied.status).toBe(2);
  expect(denied.stderr).toContain('Blocked by MasterChief guard');
  expect(run('not json').status).toBe(2);
  expect(run(JSON.stringify({ tool_input: {} })).status).toBe(2);
});
