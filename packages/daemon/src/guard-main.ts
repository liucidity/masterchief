import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import type { AgentRole } from '@masterchief/core';
import { evaluateToolCall } from './guard.js';

/**
 * Claude Code PreToolUse hook entrypoint. Reads the tool call as JSON on stdin and
 * exits 2 with the reason on stderr to block it. Kept free of the database so each
 * call starts fast. It fails closed: input it cannot read blocks the call.
 */
function main(): number {
  const { values } = parseArgs({ options: { role: { type: 'string' }, worktree: { type: 'string' }, 'report-dir': { type: 'string' } } });
  try {
    const payload = JSON.parse(readFileSync(0, 'utf8')) as { tool_name?: string; tool_input?: Record<string, unknown>; cwd?: string };
    if (!payload.tool_name) throw new Error('no tool_name in hook input');
    const decision = evaluateToolCall(
      { tool: payload.tool_name, input: payload.tool_input ?? {} },
      {
        role: (values.role ?? 'pilot') as AgentRole,
        worktree: values.worktree!,
        reportDir: values['report-dir'],
        cwd: payload.cwd ?? values.worktree!,
        env: process.env,
      },
    );
    if (decision.allow) return 0;
    process.stderr.write(`Blocked by MasterChief guard: ${decision.reason}\n`);
    return 2;
  } catch (err) {
    process.stderr.write(`Blocked by MasterChief guard (could not evaluate the call): ${(err as Error).message}\n`);
    return 2;
  }
}

process.exitCode = main();
