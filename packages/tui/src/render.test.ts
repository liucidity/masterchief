import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, Store } from '@masterchief/core';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { age, clip, render, shareRows, visibleLength } from './render.js';
import { openReadOnly, takeSnapshot, type Snapshot } from './snapshot.js';

const NOW = Date.UTC(2026, 9, 8, 12, 0, 0);
const base = (extra: Partial<Snapshot> = {}): Snapshot => ({
  home: '/h',
  now: NOW,
  watcher: { running: true, pid: 42 },
  afk: { active: false, since: null, queued: 0, needYou: 0 },
  missions: [],
  crew: [],
  cortana: [],
  alerts: [],
  ...extra,
});
const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '');
const full = base({
  missions: [
    { id: 'aaaaaaaa-1', type: 'build', status: 'running', goal: 'Add OAuth login with Google and GitHub, including the callback route', done: 1, total: 3 },
    { id: 'bbbbbbbb-2', type: 'investigate', status: 'done', goal: 'Why is checkout slow?', done: 2, total: 2 },
  ],
  crew: [
    { id: 'pilot-3f2a', role: 'pilot', harness: 'claude', model: 'opus', effort: 'high', state: 'busy', task: 'OAuth callback' },
    { id: 'sentinel-77aa', role: 'sentinel', harness: 'codex', model: 'gpt-5.6-luna', effort: 'max', state: 'dead', task: null },
  ],
  cortana: [{ id: 'triage', scope: 'issue triage', state: 'idle', crew: 2 }],
  alerts: [
    { at: NOW - 30_000, kind: 'blocked', agent: 'pilot-3f2a', text: 'looks stuck (no-events-yet)' },
    { at: NOW - 7_200_000, kind: 'landed', agent: 'pilot-1', text: 'landed (direct-pr)' },
  ],
});
const sizes: [number, number][] = [[120, 40], [100, 30], [80, 24], [72, 20], [60, 18], [50, 12], [40, 9]];

test('every line fits the width and the screen is exactly the height, at every size, with and without colour', () => {
  for (const [width, height] of sizes) {
    for (const color of [false, true]) {
      for (const showAll of [false, true]) {
        const lines = render(full, { width, height, color, showAll });
        expect(lines, `${width}x${height}`).toHaveLength(height);
        for (const l of lines) expect(visibleLength(l), `${width}x${height} ${strip(l)}`).toBeLessThanOrEqual(width);
        if (!color) for (const l of lines) expect(l).not.toContain('\x1b');
      }
    }
  }
});

test('alerts are always shown, and the least important sections go first when space runs out', () => {
  for (const [width, height] of sizes) {
    const text = render(full, { width, height, color: false, showAll: false }).join('\n');
    expect(text, `${width}x${height}`).toContain('ALERTS');
  }
  const roomy = render(full, { width: 100, height: 30, color: false, showAll: false }).join('\n');
  for (const name of ['MISSIONS', 'CREW', 'CORTANA', 'ALERTS']) expect(roomy).toContain(name);
  const tiny = render(full, { width: 50, height: 9, color: false, showAll: false }).join('\n');
  expect(tiny).not.toContain('CORTANA');
  expect(tiny).not.toContain('MISSIONS');
});

test('the header reports the watcher, away mode and the time', () => {
  const [title, status] = render(base(), { width: 80, height: 20, color: false, showAll: false });
  expect(title).toMatch(/^ MasterChief\s+\d\d:\d\d:\d\d $/);
  expect(status).toContain('● watching (pid 42)');
  expect(status).toContain('○ away mode off');
  const off = render(base({ watcher: { running: false }, afk: { active: true, since: NOW - 17 * 60_000, queued: 3, needYou: 1 } }), { width: 80, height: 20, color: false, showAll: false })[1]!;
  expect(off).toContain('× watcher not running');
  expect(off).toContain('● away 17m, 3 queued, 1 need you');
});

test('empty fleets say so instead of showing empty tables', () => {
  const text = render(base(), { width: 80, height: 24, color: false, showAll: false }).join('\n');
  expect(text).toContain('none yet');
  expect(text).toContain('no live agents');
  expect(text).toContain('nothing yet');
  expect(text).not.toContain('CORTANA');
  expect(text).not.toContain('AGENT');
});

test('finished missions are hidden until asked for, and the footer says how', () => {
  const hidden = render(full, { width: 100, height: 40, color: false, showAll: false }).join('\n');
  expect(hidden).not.toContain('bbbbbbbb');
  expect(hidden).toContain('+1 finished (press a)');
  expect(hidden).toContain('a show finished missions');
  const shown = render(full, { width: 100, height: 40, color: false, showAll: true }).join('\n');
  expect(shown).toContain('bbbbbbbb');
  expect(shown).toContain('a hide finished missions');
});

test('long text is cut with an ellipsis and states carry a glyph and a word', () => {
  const text = render(full, { width: 100, height: 40, color: false, showAll: false }).join('\n');
  expect(text).toMatch(/Add OAuth login with Google and GitHub, including the.*…/);
  expect(text).toContain('● busy');
  expect(text).toContain('× dead');
  expect(text).toContain('codex gpt-5.6-luna max');
  const narrow = render(full, { width: 80, height: 40, color: false, showAll: false }).join('\n');
  expect(narrow).not.toContain('ENGINE');
});

test('colour is applied to states and alert kinds only when asked', () => {
  const on = render(full, { width: 100, height: 40, color: true, showAll: false }).join('\n');
  expect(on).toContain('\x1b[32m● busy');
  expect(on).toContain('\x1b[31m× dead');
  expect(on).toContain('\x1b[33mblocked');
});

test('ages read naturally and spare rows are shared out fairly', () => {
  expect([age(5_000), age(90_000), age(7_200_000), age(3 * 86_400_000), age(-5)]).toEqual(['5s ago', '1m ago', '2h ago', '3d ago', '0s ago']);
  expect(shareRows(10, [8, 8, 8, 8])).toEqual([3, 3, 2, 2]);
  expect(shareRows(20, [1, 2, 30])).toEqual([1, 2, 17]);
  expect(shareRows(2, [5, 5])).toEqual([2, 2]);
});

let home: string;
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'mc-tui-'));
});
afterEach(() => rm(home, { recursive: true, force: true }));

test('a snapshot reads the database read-only and sorts alerts newest first', async () => {
  const store = new Store(openDb(join(home, 'mc.db')));
  const p = store.createProject({ path: '/p', defaultBranch: 'main', repoUrl: null });
  const m = store.createMission({ projectId: p.id, type: 'build', goal: 'g', branch: 'b', budget: null });
  store.setMissionStatus(m.id, 'running');
  const t = store.createTask({ missionId: m.id, title: 'work', dependsOn: [] });
  store.createAgent({ id: 'pilot-a', role: 'pilot', harness: 'claude', model: 'opus' });
  store.updateAgent('pilot-a', { state: 'busy' });
  store.assignTask(t.id, 'pilot-a');
  store.createAgent({ id: 'pilot-gone', role: 'pilot', harness: 'claude' });
  store.updateAgent('pilot-gone', { state: 'retired' });
  store.addEvent({ missionId: m.id, agentId: 'pilot-a', kind: 'dead', payload: { reason: 'endpoint-exited' }, ts: NOW - 1000 });
  store.addEvent({ missionId: m.id, agentId: 'pilot-a', kind: 'finished', payload: {}, ts: NOW - 9000 });
  store.addEvent({ missionId: m.id, agentId: 'pilot-a', kind: 'spawned', payload: {}, ts: NOW });
  store.setAfkActive(true);
  store.addAfkItem({ eventSeq: 1, kind: 'blocked', needsHuman: true, agentId: 'pilot-a', taskId: null, summary: 's', detail: '' });
  await writeFile(join(home, 'watch.pid'), String(process.pid));

  const ro = openReadOnly(home)!;
  expect(() => ro.setSetting('x', 'y')).toThrow();
  const snap = await takeSnapshot(home, ro, NOW);
  expect(snap.crew.map((c) => [c.id, c.task])).toEqual([['pilot-a', 'work']]);
  expect(snap.missions).toEqual([{ id: m.id, type: 'build', status: 'running', goal: 'g', done: 0, total: 1 }]);
  expect(snap.alerts.map((a) => a.kind)).toEqual(['dead', 'finished']);
  expect(snap.watcher).toEqual({ running: true, pid: process.pid });
  expect(snap.afk).toMatchObject({ active: true, queued: 1, needYou: 1 });
});

test('there is nothing to open when no database exists, and a dead watcher lock reads as not running', async () => {
  expect(openReadOnly(home)).toBeUndefined();
  const store = new Store(openDb(join(home, 'mc.db')));
  await writeFile(join(home, 'watch.pid'), '999999');
  expect((await takeSnapshot(home, store, NOW)).watcher).toEqual({ running: false });
});

test('Cortana rows show her state and how many agents her crew has in flight', async () => {
  const her = join(home, 'cortana', 'triage');
  const herStore = new Store(openDb((await import('node:fs/promises').then((f) => f.mkdir(her, { recursive: true }).then(() => join(her, 'mc.db'))))));
  const hp = herStore.createProject({ path: '/clone', defaultBranch: 'main', repoUrl: null });
  const hm = herStore.createMission({ projectId: hp.id, type: 'build', goal: 'g', branch: 'b', budget: null });
  const live = herStore.createAgent({ id: 'pilot-h1', role: 'pilot', harness: 'claude' });
  const gone = herStore.createAgent({ id: 'pilot-h2', role: 'pilot', harness: 'claude' });
  herStore.updateAgent(gone.id, { state: 'retired' });
  for (const a of [live, gone]) herStore.assignTask(herStore.createTask({ missionId: hm.id, title: a.id, dependsOn: [] }).id, a.id);

  const store = new Store(openDb(join(home, 'mc.db')));
  store.createCortanaHome({ id: 'triage', scope: 'triage', projects: [], homePath: her, route: 'local', harness: null });
  expect((await takeSnapshot(home, store, NOW)).cortana).toEqual([{ id: 'triage', scope: 'triage', state: 'stopped', crew: 1 }]);
  store.createAgent({ id: 'cortana-triage', role: 'cortana', harness: 'claude' });
  store.updateAgent('cortana-triage', { state: 'idle' });
  expect((await takeSnapshot(home, store, NOW)).cortana[0]).toMatchObject({ state: 'idle', crew: 1 });
});

test('clip keeps colour codes balanced when it cuts a styled line', () => {
  const styled = '\x1b[31mabcdefghij\x1b[39m';
  expect(strip(clip(styled, 6))).toBe('abcde…');
  expect(clip(styled, 6).endsWith('\x1b[0m')).toBe(true);
  expect(clip(styled, 20)).toBe(styled);
  expect(clip('plain text here', 6)).toBe('plain…');
});
