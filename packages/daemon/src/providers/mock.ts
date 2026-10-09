import type { AgentEvent, AgentSession, ProviderAdapter, ProviderCapabilities, SessionSpec } from './types.js';

export type MockStep =
  | { kind: 'text'; text: string }
  | { kind: 'tool'; tool: string; args: Record<string, unknown>; output: string };

/** Replays a script through the gate, with no model calls. Every send() plays the full script. */
export function createMockAdapter(
  script: MockStep[],
  capabilities: ProviderCapabilities = { tools: true, streaming: true, maxContext: 100_000 },
): ProviderAdapter & { sent: string[] } {
  const sent: string[] = [];
  return {
    capabilities,
    sent,
    start(spec: SessionSpec): AgentSession {
      let closed = false;
      return {
        async *send(message: string): AsyncGenerator<AgentEvent> {
          if (closed) throw new Error('session is closed');
          sent.push(message);
          let n = 0;
          for (const step of script) {
            if (step.kind === 'text') {
              yield { kind: 'text', text: step.text };
              continue;
            }
            const id = `t${++n}`;
            yield { kind: 'tool_call', id, tool: step.tool, args: step.args };
            const decision = spec.gate({ tool: step.tool, args: step.args });
            yield decision.allow
              ? { kind: 'tool_result', id, ok: true, output: step.output }
              : { kind: 'tool_result', id, ok: false, output: `denied: ${decision.reason}` };
          }
          yield { kind: 'done', usage: { inputTokens: 0, outputTokens: 0 } };
        },
        async close() {
          closed = true;
        },
      };
    },
  };
}
