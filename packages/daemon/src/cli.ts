import { parseArgs } from 'node:util';
import { listHarnesses } from './harness.js';
import { McError, type Mc } from './mc.js';

export interface CliIO {
  out(text: string): void;
  err(text: string): void;
}

const HELP = `mc - control the MasterChief crew

  mc project add <path> [--mode direct-pr|no-mistakes|local-only]
  mc project list
  mc mission new --project <id|path> --type build|investigate --goal <text>
  mc mission list | mc mission show <id>
  mc spawn --mission <id> --kind ship|sentinel --title <text> --harness <name>
           [--model <m>] [--effort <e>] [--brief <text|@file>] [--permission-mode <m>]
  mc status [<task|agent>] [--lines <n>]
  mc send <task|agent> [--text <t>] [--keys Enter,Escape] [--interrupt] [--no-enter]
  mc teardown <task|agent> [--force] [--outcome done|failed]
  mc events [--after <seq>] [--peek] [--mission <id>]
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
            model: { type: 'string' }, effort: { type: 'string' }, brief: { type: 'string' }, 'permission-mode': { type: 'string' },
          },
        });
        print(
          await mc.spawn({
            missionId: need(values.mission, 'mission'),
            kind: oneOf(values.kind, 'kind', ['ship', 'sentinel'] as const),
            title: need(values.title, 'title'),
            harness: need(values.harness, 'harness'),
            model: values.model,
            effort: values.effort,
            brief: values.brief ? await mc.readBrief(values.brief) : undefined,
            permissionMode: values['permission-mode'],
          }),
        );
        return 0;
      }

      case 'status': {
        const { values, positionals } = parseArgs({ args: rest, allowPositionals: true, options: { lines: { type: 'string' } } });
        print(await mc.status(positionals[0], { lines: values.lines ? Number(values.lines) : undefined }));
        return 0;
      }

      case 'send': {
        const { values, positionals } = parseArgs({
          args: rest,
          allowPositionals: true,
          options: { text: { type: 'string' }, keys: { type: 'string' }, interrupt: { type: 'boolean' }, 'no-enter': { type: 'boolean' } },
        });
        print(await mc.send(need(positionals[0], 'task (positional)'), { text: values.text, keys: values.keys?.split(',').filter(Boolean), interrupt: values.interrupt, noEnter: values['no-enter'] }));
        return 0;
      }

      case 'teardown': {
        const { values, positionals } = parseArgs({ args: rest, allowPositionals: true, options: { force: { type: 'boolean' }, outcome: { type: 'string' } } });
        const outcome = values.outcome ? oneOf(values.outcome, 'outcome', ['done', 'failed'] as const) : undefined;
        print(await mc.teardown(need(positionals[0], 'task (positional)'), { force: values.force, outcome }));
        return 0;
      }

      case 'events': {
        const { values } = parseArgs({ args: rest, options: { after: { type: 'string' }, peek: { type: 'boolean' }, mission: { type: 'string' } } });
        print(mc.events({ after: values.after !== undefined ? Number(values.after) : undefined, peek: values.peek, mission: values.mission }));
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
