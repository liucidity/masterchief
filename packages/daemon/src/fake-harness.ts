import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { hookLogPath } from './claude.js';
import type { Harness, HarnessPrepareOptions } from './harness.js';

/**
 * A stand-in CLI for tests: a shell loop that echoes each line it is given and
 * reports turn start and end through the same hook-log protocol as a real harness.
 */
export const fakeHarness: Harness = {
  id: 'fake',
  efforts: ['low', 'high'],
  semanticBusy: true,
  exitText: 'exit',
  interruptKeys: ['C-c'],
  validate(model, effort) {
    if (effort != null && !['low', 'high'].includes(effort)) return `invalid effort for fake: ${effort}`;
    if (model === 'bad-model') return 'invalid model: bad-model';
    return null;
  },
  async prepare(opts: HarnessPrepareOptions) {
    await mkdir(opts.stateDir, { recursive: true });
    const gen = randomUUID();
    const hookLog = hookLogPath(opts.stateDir, opts.agentId);
    const script = [
      `ev() { printf '%s %s %s\\n' '${gen}' "$(date +%s)" "$1" >> '${hookLog}'; }`,
      `turn() { ev prompt; case "$1" in slow*) sleep 1.5;; ask*) ev waiting; sleep 1.5; ev working; sleep 1;; hang*) sleep 60;; "do: "*) sh -c "${'$'}{1#do: }";; esac; echo "got: $1"; ev stop; }`,
      `echo ready`,
      `if [ -n "$MC_FIRST" ]; then turn "$MC_FIRST"; fi`,
      `while IFS= read -r line; do turn "$line"; done`,
    ].join('\n');
    return {
      command: ['sh', '-c', script],
      env: { MC_FIRST: opts.initialPrompt ?? '', MC_AGENT_ID: opts.agentId },
      gen,
      hookLog,
    };
  },
};
