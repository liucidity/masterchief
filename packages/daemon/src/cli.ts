import { spawnSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { listHarnesses } from './harness.js';
import { McError, type Mc } from './mc.js';

export interface CliIO {
  out(text: string): void;
  err(text: string): void;
  /** Ends long-running commands such as watch. Defaults to SIGINT and SIGTERM. */
  signal?: AbortSignal;
}

const HELP = `mc - control the MasterChief crew

  mc project add <path> [--mode direct-pr|no-mistakes|local-only]
  mc project list
  mc mission new --project <id|path> --type build|investigate --goal <text>
  mc mission list | mc mission show <id> | mc mission finish <id> [--abort]
  mc spawn --mission <id> --kind ship|sentinel --title <text> [--harness <name>] [--tier small]
           [--model <m>] [--effort <e>] [--brief <text|@file>] [--permission-mode <m>]
  mc status [<task|agent>] [--lines <n>] [--attention]
  mc send <task|agent> [--text <t>] [--keys Enter,Escape] [--interrupt] [--no-enter] [--force]
  mc finding add --mission <id> --claim <t> --evidence <t> --confidence <0-1> | mc finding list --mission <id>
  mc review <task|agent> --verdict approve|reject|escalate --notes <why>
  mc land <task|agent> [--title <t>] [--body <b>]
  mc teardown <task|agent> [--force] [--outcome done|failed]
  mc events [--ack <seq>] [--after <seq>] [--mission <id>]
  mc watch [--interval <ms>] [--once] [--unknown-after <s>] [--stale-after <s>]
  mc watch --status | --background | --stop
  mc commander start [--harness <h>] [--model <m>] [--effort <e>] [--fresh]
  mc commander stop | mc commander status
  mc afk start [--note <text>] | stop | status | brief [--last]
  mc attach
  mc cortana seed --scope <text> --project <id|path> [--project ...] [--id <slug>] [--harness <h>]
  mc cortana list | start <id> [--fresh] | send <id> --text <t> | status <id> | sync <id>
  mc cortana teardown <id> [--force] [--purge]
  mc dispatch [--init]
  mc prune [--apply] [--force]
  mc harnesses

Every command prints JSON. Errors go to stderr with exit code 1.`;

const need = (v: string | undefined, flag: string): string => {
  if (!v) throw new McError(`missing --${flag}`);
  return v;
};
const oneOf = <T extends string>(v: string | undefined, flag: string, allowed: readonly T[]): T => {
  if (!v || !allowed.includes(v as T)) throw new McError(`--${flag} must be one of: ${allowed.join(', ')}`);
  return v as T;
};

/** Every top-level command, for checks that documentation mentions only real ones. */
export const COMMANDS = ['project', 'mission', 'spawn', 'status', 'send', 'land', 'teardown', 'events', 'review', 'finding', 'dispatch', 'prune', 'watch', 'commander', 'cortana', 'afk', 'attach', 'harnesses', 'help'];

/** Runs one mc command line. Returns the process exit code. */
export async function runCli(argv: string[], mc: Mc, io: CliIO): Promise<number> {
  const print = (v: unknown) => io.out(JSON.stringify(v, null, 2));
  const [cmd, ...rest] = argv;
  try {
    switch (cmd) {
      case undefined:
      case 'help':
      case '--help':
        io.out(HELP);
        return 0;

      case 'project': {
        const [sub, ...a] = rest;
        if (sub === 'list') return (print(mc.listProjects()), 0);
        if (sub === 'add') {
          const { values, positionals } = parseArgs({ args: a, allowPositionals: true, options: { mode: { type: 'string' }, branch: { type: 'string' } } });
          const mode = values.mode ? oneOf(values.mode, 'mode', ['direct-pr', 'no-mistakes', 'local-only'] as const) : undefined;
          print(await mc.addProject({ path: need(positionals[0], 'path (positional)'), mode, defaultBranch: values.branch }));
          return 0;
        }
        throw new McError('usage: mc project add|list');
      }

      case 'mission': {
        const [sub, ...a] = rest;
        if (sub === 'new') {
          const { values } = parseArgs({ args: a, options: { project: { type: 'string' }, type: { type: 'string' }, goal: { type: 'string' } } });
          print(mc.newMission({ project: need(values.project, 'project'), type: oneOf(values.type, 'type', ['build', 'investigate'] as const), goal: need(values.goal, 'goal') }));
          return 0;
        }
        if (sub === 'list') return (print(mc.listMissions()), 0);
        if (sub === 'finish') {
          const { values, positionals } = parseArgs({ args: a, allowPositionals: true, options: { abort: { type: 'boolean' } } });
          print(mc.finishMission(need(positionals[0], 'mission id'), { abort: values.abort }));
          return 0;
        }
        if (sub === 'show') {
          print(mc.showMission(need(a[0], 'mission id')));
          return 0;
        }
        throw new McError('usage: mc mission new|list|show');
      }

      case 'spawn': {
        const { values } = parseArgs({
          args: rest,
          options: {
            mission: { type: 'string' }, kind: { type: 'string' }, title: { type: 'string' }, harness: { type: 'string' },
            model: { type: 'string' }, effort: { type: 'string' }, brief: { type: 'string' }, 'permission-mode': { type: 'string' }, tier: { type: 'string' },
          },
        });
        print(
          await mc.spawn({
            missionId: need(values.mission, 'mission'),
            kind: oneOf(values.kind, 'kind', ['ship', 'sentinel'] as const),
            title: need(values.title, 'title'),
            harness: values.harness,
            tier: values.tier ? oneOf(values.tier, 'tier', ['small'] as const) : undefined,
            model: values.model,
            effort: values.effort,
            brief: values.brief ? await mc.readBrief(values.brief) : undefined,
            permissionMode: values['permission-mode'],
          }),
        );
        return 0;
      }

      case 'status': {
        const { values, positionals } = parseArgs({ args: rest, allowPositionals: true, options: { lines: { type: 'string' }, attention: { type: 'boolean' } } });
        if (positionals[0]) return (print(await mc.status(positionals[0], { lines: values.lines ? Number(values.lines) : undefined })), 0);
        const fleet = await mc.status();
        print(values.attention ? fleet.filter((r) => r.attention) : fleet);
        return 0;
      }

      case 'send': {
        const { values, positionals } = parseArgs({
          args: rest,
          allowPositionals: true,
          options: { text: { type: 'string' }, keys: { type: 'string' }, interrupt: { type: 'boolean' }, 'no-enter': { type: 'boolean' }, force: { type: 'boolean' } },
        });
        print(await mc.send(need(positionals[0], 'task (positional)'), { text: values.text, keys: values.keys?.split(',').filter(Boolean), interrupt: values.interrupt, noEnter: values['no-enter'], force: values.force }));
        return 0;
      }

      case 'finding': {
        const [sub, ...a] = rest;
        const { values } = parseArgs({ args: a, options: { mission: { type: 'string' }, claim: { type: 'string' }, evidence: { type: 'string' }, confidence: { type: 'string' } } });
        if (sub === 'list') return (print(mc.listFindings(need(values.mission, 'mission'))), 0);
        if (sub === 'add') {
          print(mc.addFinding({ mission: need(values.mission, 'mission'), claim: need(values.claim, 'claim'), evidence: need(values.evidence, 'evidence'), confidence: Number(need(values.confidence, 'confidence')) }));
          return 0;
        }
        throw new McError('usage: mc finding add|list');
      }

      case 'review': {
        const { values, positionals } = parseArgs({ args: rest, allowPositionals: true, options: { verdict: { type: 'string' }, notes: { type: 'string' } } });
        print(mc.review(need(positionals[0], 'task (positional)'), { verdict: oneOf(values.verdict, 'verdict', ['approve', 'reject', 'escalate'] as const), notes: need(values.notes, 'notes') }));
        return 0;
      }

      case 'land': {
        const { values, positionals } = parseArgs({ args: rest, allowPositionals: true, options: { title: { type: 'string' }, body: { type: 'string' } } });
        print(await mc.land(need(positionals[0], 'task (positional)'), { title: values.title, body: values.body }));
        return 0;
      }

      case 'teardown': {
        const { values, positionals } = parseArgs({ args: rest, allowPositionals: true, options: { force: { type: 'boolean' }, outcome: { type: 'string' } } });
        const outcome = values.outcome ? oneOf(values.outcome, 'outcome', ['done', 'failed'] as const) : undefined;
        print(await mc.teardown(need(positionals[0], 'task (positional)'), { force: values.force, outcome }));
        return 0;
      }

      case 'events': {
        const { values } = parseArgs({ args: rest, options: { after: { type: 'string' }, ack: { type: 'string' }, mission: { type: 'string' } } });
        print(mc.events({ after: values.after !== undefined ? Number(values.after) : undefined, ack: values.ack !== undefined ? Number(values.ack) : undefined, mission: values.mission }));
        return 0;
      }

      case 'watch': {
        const { values } = parseArgs({
          args: rest,
          options: {
            interval: { type: 'string' }, once: { type: 'boolean' }, 'unknown-after': { type: 'string' }, 'stale-after': { type: 'string' },
            status: { type: 'boolean' }, background: { type: 'boolean' }, stop: { type: 'boolean' },
          },
        });
        if (values.status) return (print(await mc.watchStatus()), 0);
        if (values.background) return (print(await mc.ensureWatcherBackground()), 0);
        if (values.stop) return (print(await mc.stopWatcher()), 0);
        const w = mc.watcher({
          unknownAfterSecs: values['unknown-after'] ? Number(values['unknown-after']) : undefined,
          staleAfterSecs: values['stale-after'] ? Number(values['stale-after']) : undefined,
        });
        if (values.once) return (print(await w.tick()), 0);
        const release = await mc.acquireWatchLock();
        const ctl = new AbortController();
        const stop = () => ctl.abort();
        const signals = io.signal ? [] : (['SIGINT', 'SIGTERM'] as const);
        for (const s of signals) process.once(s, stop);
        io.signal?.addEventListener('abort', stop, { once: true });
        try {
          await w.run(ctl.signal, values.interval ? Number(values.interval) : undefined);
        } finally {
          for (const s of signals) process.off(s, stop);
          await release();
        }
        return 0;
      }

      case 'commander': {
        const [sub, ...a] = rest;
        if (sub === 'start') {
          const { values } = parseArgs({ args: a, options: { harness: { type: 'string' }, model: { type: 'string' }, effort: { type: 'string' }, fresh: { type: 'boolean' } } });
          print(await mc.commanderStart({ harness: values.harness, model: values.model, effort: values.effort, fresh: values.fresh }));
          return 0;
        }
        if (sub === 'stop') return (print(await mc.commanderStop()), 0);
        if (sub === 'status') return (print(await mc.commanderStatus()), 0);
        throw new McError('usage: mc commander start|stop|status');
      }

      case 'cortana': {
        const [sub, ...a] = rest;
        const { values, positionals } = parseArgs({
          args: a,
          allowPositionals: true,
          options: {
            scope: { type: 'string' }, project: { type: 'string', multiple: true }, id: { type: 'string' }, harness: { type: 'string' },
            fresh: { type: 'boolean' }, text: { type: 'string' }, force: { type: 'boolean' }, purge: { type: 'boolean' }, lines: { type: 'string' },
          },
        });
        const id = positionals[0];
        const cortana = mc.cortana;
        switch (sub) {
          case 'seed':
            print(await cortana.seed({ scope: need(values.scope, 'scope'), projects: values.project ?? [], id: values.id, harness: values.harness }));
            return 0;
          case 'list':
            print(cortana.list());
            return 0;
          case 'start':
            print(await cortana.start(need(id, 'cortana id'), { fresh: values.fresh }));
            return 0;
          case 'send':
            print(await cortana.send(need(id, 'cortana id'), need(values.text, 'text')));
            return 0;
          case 'status':
            print(await cortana.status(need(id, 'cortana id'), values.lines ? Number(values.lines) : undefined));
            return 0;
          case 'sync':
            print(await cortana.sync(need(id, 'cortana id')));
            return 0;
          case 'teardown':
            print(await cortana.teardown(need(id, 'cortana id'), { force: values.force, purge: values.purge }));
            return 0;
          default:
            throw new McError('usage: mc cortana seed|list|start|send|status|sync|teardown');
        }
      }

      case 'afk': {
        const [sub, ...a] = rest;
        const { values } = parseArgs({ args: a, options: { note: { type: 'string' }, last: { type: 'boolean' }, interval: { type: 'string' } } });
        switch (sub) {
          case 'start':
            print(await mc.afk.start({ note: values.note }));
            return 0;
          case 'stop':
            print(await mc.afk.stop());
            return 0;
          case 'status':
            print(await mc.afk.status());
            return 0;
          case 'brief':
            print(mc.afk.brief({ last: values.last }));
            return 0;
          case 'run': {
            const ctl = new AbortController();
            const stop = () => ctl.abort();
            const signals = io.signal ? [] : (['SIGINT', 'SIGTERM'] as const);
            for (const s of signals) process.once(s, stop);
            io.signal?.addEventListener('abort', stop, { once: true });
            try {
              await mc.afk.run(ctl.signal, values.interval ? Number(values.interval) : undefined);
            } finally {
              for (const s of signals) process.off(s, stop);
            }
            return 0;
          }
          default:
            throw new McError('usage: mc afk start|stop|status|brief|run');
        }
      }

      case 'attach': {
        const [bin, ...args] = mc.attachCommand();
        const r = spawnSync(bin!, args, { stdio: 'inherit' });
        return r.status ?? 1;
      }

      case 'dispatch': {
        const { values } = parseArgs({ args: rest, options: { init: { type: 'boolean' } } });
        print(values.init ? await mc.dispatchInit() : await mc.dispatchInfo());
        return 0;
      }

      case 'prune': {
        const { values } = parseArgs({ args: rest, options: { apply: { type: 'boolean' }, force: { type: 'boolean' } } });
        print(await mc.prune({ apply: values.apply, force: values.force }));
        return 0;
      }

      case 'harnesses':
        print(listHarnesses());
        return 0;

      default:
        io.err(`unknown command: ${cmd}\n\n${HELP}`);
        return 1;
    }
  } catch (err) {
    if (err instanceof McError || (err as { code?: string }).code?.startsWith('ERR_PARSE_ARGS')) {
      io.err(`error: ${(err as Error).message}`);
    } else {
      io.err(`error: ${(err as Error).stack ?? err}`);
    }
    return 1;
  }
}
