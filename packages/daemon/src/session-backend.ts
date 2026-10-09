export type EndpointStatus = 'alive' | 'dead' | 'missing';

export interface CreateSessionOptions {
  /** Human-readable window title. */
  name: string;
  cwd: string;
  /** Program and arguments to run. Defaults to the user's shell. */
  command?: string[];
  env?: Record<string, string>;
}

export interface SessionInfo {
  endpoint: string;
  name: string;
  status: EndpointStatus;
}

/** The terminal layer below the CLI agents: one endpoint per agent window. */
export interface SessionBackend {
  /** Start a window and return its endpoint id. */
  create(opts: CreateSessionOptions): Promise<string>;
  /** Paste text into the window as typed input, without pressing Enter. */
  sendText(endpoint: string, text: string): Promise<void>;
  /** Press named keys, such as Enter, Escape or C-c. */
  sendKeys(endpoint: string, ...keys: string[]): Promise<void>;
  /** The last `lines` lines of the visible screen and scrollback. */
  capture(endpoint: string, lines?: number): Promise<string>;
  /** Dead means the window exists but its process has exited; missing means no window. */
  status(endpoint: string): Promise<EndpointStatus>;
  destroy(endpoint: string): Promise<void>;
  list(): Promise<SessionInfo[]>;
}
