import { relative, resolve } from 'node:path';
import { READ_TOOLS, WRITE_TOOLS, argPath } from './tools.js';
import type { AgentEvent } from './types.js';

export interface FileActivity {
  opened: string[];
  touched: string[];
}

/**
 * Derive which files an agent read and changed from its raw events. Only calls
 * whose result succeeded count, so denied or failed calls leave no trace.
 */
export function deriveFileActivity(events: AgentEvent[], worktreePath: string): FileActivity {
  const succeeded = new Set(events.flatMap((e) => (e.kind === 'tool_result' && e.ok ? [e.id] : [])));
  const opened = new Set<string>();
  const touched = new Set<string>();
  for (const e of events) {
    if (e.kind !== 'tool_call' || !succeeded.has(e.id)) continue;
    const path = argPath(e.args);
    if (path === undefined) continue;
    const rel = relative(resolve(worktreePath), resolve(worktreePath, path));
    if (READ_TOOLS.includes(e.tool)) opened.add(rel);
    else if (WRITE_TOOLS.includes(e.tool)) touched.add(rel);
  }
  return { opened: [...opened].sort(), touched: [...touched].sort() };
}
