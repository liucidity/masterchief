/** Normalized tool names. Adapters map provider-specific names onto these. */
export const READ_TOOLS = ['read', 'glob', 'grep'];
export const WRITE_TOOLS = ['write', 'edit'];

export const isPathTool = (tool: string) => READ_TOOLS.includes(tool) || WRITE_TOOLS.includes(tool);

export const argPath = (args: Record<string, unknown>): string | undefined =>
  typeof args.path === 'string' ? args.path : undefined;
