import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { promisify } from 'node:util';
import type { CreateSessionOptions, EndpointStatus, SessionBackend, SessionInfo } from './session-backend.js';

const run = promisify(execFile);

export interface TmuxOptions {
  /** tmux socket name (-L). Isolates this backend's server from the user's own tmux. */
  socket?: string;
  /** Session that holds one window per agent. */
  session?: string;
}

export class TmuxBackend implements SessionBackend {
  private socket: string;
  private session: string;

  constructor(opts: TmuxOptions = {}) {
    this.socket = opts.socket ?? 'masterchief';
    this.session = opts.session ?? 'mc';
  }

  private async tmux(...args: string[]): Promise<string> {
    const { stdout } = await run('tmux', ['-L', this.socket, ...args], { maxBuffer: 16 * 1024 * 1024 });
    return stdout;
  }

  /**
   * Windows must outlive their program so a crash is visible, and that has to be
   * set before the program starts or a fast-failing command takes the server with it.
   */
  private async prepareServer(): Promise<void> {
    await this.tmux(
      'start-server', ';',
      'set-option', '-g', 'exit-empty', 'off', ';',
      'set-option', '-g', 'remain-on-exit', 'on',
    );
  }

  async create(opts: CreateSessionOptions): Promise<string> {
    await this.prepareServer();
    const entries = Object.entries(opts.env ?? {});
    for (const [k] of entries) if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) throw new Error(`invalid environment variable name: ${k}`);
    // tmux ignores -e for some variables (PATH among them), so a command gets its environment
    // from `env`, which always wins. Only a default shell falls back to -e.
    const viaEnv = opts.command?.length ? ['env', ...entries.map(([k, v]) => `${k}=${v}`), ...opts.command] : [];
    const envArgs = viaEnv.length ? [] : entries.flatMap(([k, v]) => ['-e', `${k}=${v}`]);
    const base = ['-d', '-P', '-F', '#{window_id}', '-n', opts.name, '-c', opts.cwd, ...envArgs, ...(viaEnv.length ? viaEnv : (opts.command ?? []))];
    let id: string;
    try {
      id = await this.tmux('new-window', '-t', `${this.session}:`, ...base);
    } catch (err) {
      if (!/can't find session|no current target|no server running|error connecting/i.test(String((err as Error).message))) throw err;
      try {
        id = await this.tmux('new-session', '-s', this.session, ...base);
      } catch (err2) {
        if (!/duplicate session/i.test(String((err2 as Error).message))) throw err2;
        id = await this.tmux('new-window', '-t', `${this.session}:`, ...base);
      }
    }
    return id.trim();
  }

  async sendText(endpoint: string, text: string): Promise<void> {
    const buffer = `mc-${randomUUID()}`;
    await this.tmux('set-buffer', '-b', buffer, '--', text);
    await this.tmux('paste-buffer', '-p', '-d', '-b', buffer, '-t', endpoint);
  }

  async sendKeys(endpoint: string, ...keys: string[]): Promise<void> {
    await this.tmux('send-keys', '-t', endpoint, ...keys);
  }

  async capture(endpoint: string, lines = 200): Promise<string> {
    const out = await this.tmux('capture-pane', '-p', '-t', endpoint, '-S', `-${lines}`);
    return out.replace(/\s+$/, '');
  }

  async status(endpoint: string): Promise<EndpointStatus> {
    try {
      const out = await this.tmux('list-windows', '-a', '-F', '#{window_id}\t#{pane_dead}');
      const row = out.split('\n').find((l) => l.split('\t')[0] === endpoint);
      if (!row) return 'missing';
      return row.split('\t')[1] === '1' ? 'dead' : 'alive';
    } catch {
      return 'missing';
    }
  }

  /**
   * Close the window and wait for its program to finish exiting. A CLI that is told to hang up may
   * still be writing its config on the way out, and anything done to that config sooner would be
   * overwritten by it.
   */
  async destroy(endpoint: string, waitMs = 8000): Promise<void> {
    const pid = Number((await this.tmux('display-message', '-p', '-t', endpoint, '#{pane_pid}').catch(() => '')).trim());
    await this.tmux('kill-window', '-t', endpoint).catch(() => undefined);
    if (!(pid > 1)) return;
    const end = Date.now() + waitMs;
    while (Date.now() < end) {
      try {
        process.kill(pid, 0);
      } catch {
        return;
      }
      await new Promise((r) => setTimeout(r, 25));
    }
  }

  async list(): Promise<SessionInfo[]> {
    let out: string;
    try {
      out = await this.tmux('list-windows', '-t', `${this.session}:`, '-F', '#{window_id}\t#{window_name}\t#{pane_dead}');
    } catch {
      return [];
    }
    return out
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [endpoint, name, dead] = line.split('\t');
        return { endpoint: endpoint!, name: name!, status: dead === '1' ? 'dead' : 'alive' } as SessionInfo;
      });
  }

  attachCommand(endpoint: string): string[] {
    return ['tmux', '-L', this.socket, 'select-window', '-t', endpoint, ';', 'attach-session', '-t', this.session];
  }

  /** Stop the whole tmux server for this socket. Used by tests. */
  async killServer(): Promise<void> {
    const path = (await this.tmux('display-message', '-p', '#{socket_path}').catch(() => '')).trim();
    await this.tmux('kill-server').catch(() => undefined);
    // tmux leaves its socket file behind after a kill; remove it so tests do not accumulate them.
    if (path) await rm(path, { force: true });
  }
}
