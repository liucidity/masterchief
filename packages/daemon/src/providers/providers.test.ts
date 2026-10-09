import { expect, test } from 'vitest';
import { checkCapabilities } from './capabilities.js';
import { deriveFileActivity } from './files.js';
import { createGate } from './gate.js';
import { createMockAdapter } from './mock.js';
import type { AgentEvent, SessionSpec } from './types.js';

const WT = '/repo/.mc/wt/eng-1';
const gateFor = (role: 'engineer' | 'reviewer', tools = ['read', 'edit', 'bash']) =>
  createGate({ role, worktreePath: WT, permissions: { tools } });

test('gate allows a write inside the worktree for a writer role', () => {
  expect(gateFor('engineer')({ tool: 'edit', args: { path: 'src/a.ts' } })).toEqual({ allow: true });
  expect(gateFor('engineer')({ tool: 'read', args: { path: '.' } })).toEqual({ allow: true });
});

test('gate denies paths outside the worktree', () => {
  for (const path of ['../other/a.ts', '/etc/passwd', 'src/../../x']) {
    const d = gateFor('engineer')({ tool: 'edit', args: { path } });
    expect(d).toMatchObject({ allow: false });
  }
});

test('gate denies writes for read-only roles and tools not permitted', () => {
  expect(gateFor('reviewer')({ tool: 'edit', args: { path: 'a.ts' } })).toMatchObject({
    allow: false,
    reason: expect.stringContaining('read-only'),
  });
  expect(gateFor('engineer', ['read'])({ tool: 'edit', args: { path: 'a.ts' } })).toMatchObject({
    allow: false,
    reason: expect.stringContaining('not permitted'),
  });
});

test('gate denies path tools without a path', () => {
  expect(gateFor('engineer')({ tool: 'read', args: {} })).toMatchObject({ allow: false });
});

test('capability check reports every missing capability', () => {
  const caps = { tools: false, streaming: true, maxContext: 8000 };
  expect(checkCapabilities(caps, { tools: false, streaming: true, contextTokens: 100 })).toEqual({ ok: true });
  const res = checkCapabilities(caps, { tools: true, streaming: true, contextTokens: 9000 });
  expect(res).toMatchObject({ ok: false });
  expect(res.ok ? [] : res.reasons).toHaveLength(2);
});

test('file activity is derived from successful calls only', () => {
  const events: AgentEvent[] = [
    { kind: 'tool_call', id: '1', tool: 'read', args: { path: 'a.ts' } },
    { kind: 'tool_result', id: '1', ok: true, output: '' },
    { kind: 'tool_call', id: '2', tool: 'edit', args: { path: `${WT}/b.ts` } },
    { kind: 'tool_result', id: '2', ok: true, output: '' },
    { kind: 'tool_call', id: '3', tool: 'edit', args: { path: 'c.ts' } },
    { kind: 'tool_result', id: '3', ok: false, output: 'denied: nope' },
    { kind: 'tool_call', id: '4', tool: 'edit', args: { path: 'd.ts' } },
  ];
  expect(deriveFileActivity(events, WT)).toEqual({ opened: ['a.ts'], touched: ['b.ts'] });
});

const collect = async (it: AsyncIterable<AgentEvent>) => {
  const out: AgentEvent[] = [];
  for await (const e of it) out.push(e);
  return out;
};

const specFor = (role: 'engineer' | 'reviewer'): SessionSpec => ({
  role,
  instructions: 'do it',
  context: '',
  cwd: WT,
  permissions: { tools: ['read', 'edit'] },
  model: 'mock',
  gate: gateFor(role),
});

test('mock adapter streams events and routes tool calls through the gate', async () => {
  const adapter = createMockAdapter([
    { kind: 'text', text: 'working' },
    { kind: 'tool', tool: 'edit', args: { path: 'a.ts' }, output: 'ok' },
    { kind: 'tool', tool: 'edit', args: { path: '../x.ts' }, output: 'ok' },
  ]);
  const session = adapter.start(specFor('engineer'));
  const events = await collect(session.send('go'));
  expect(adapter.sent).toEqual(['go']);
  expect(events.map((e) => e.kind)).toEqual([
    'text', 'tool_call', 'tool_result', 'tool_call', 'tool_result', 'done',
  ]);
  expect(events[4]).toMatchObject({ kind: 'tool_result', ok: false });
  expect(deriveFileActivity(events, WT).touched).toEqual(['a.ts']);
});

test('mock adapter denies writes for a read-only role and supports follow-up sends', async () => {
  const adapter = createMockAdapter([{ kind: 'tool', tool: 'edit', args: { path: 'a.ts' }, output: 'ok' }]);
  const session = adapter.start(specFor('reviewer'));
  const first = await collect(session.send('one'));
  expect(first[1]).toMatchObject({ kind: 'tool_result', ok: false });
  await collect(session.send('two'));
  expect(adapter.sent).toEqual(['one', 'two']);
  await session.close();
  await expect(collect(session.send('three'))).rejects.toThrow('closed');
});
