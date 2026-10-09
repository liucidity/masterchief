# MasterChief

Talk to one agent, the Commander, and let it run a crew of real coding-agent CLIs.
Each crew member works in its own git worktree, in its own terminal window.
MasterChief never calls a model API itself: it launches and steers the CLIs you already use, so plan login and API keys both work.
The design is modeled on [firstmate](https://github.com/kunchenguid/firstmate), and the plan lives in `docs/plans/masterchief.md`.

## Requirements

- Node 24 or newer, for `node:sqlite`.
- `git` and `tmux`.
- The Claude Code CLI (`claude`), logged in. This is the one harness verified live.
- `gh`, authenticated, only for projects delivered by pull request.
- The Codex CLI is optional. Its launch recipe exists but has not been run against a real Codex yet.

## Build and test

```sh
npm install
npm run build
npm test
```

`mc` is `packages/daemon/dist/cli-main.js` and `mc-tui` is `packages/tui/dist/main.js`.
Alias them, for example `alias mc='node ~/path/to/masterchief/packages/daemon/dist/cli-main.js'`.

## Quick start

```sh
export MC_HOME=~/.masterchief        # database, per-agent state, reports, config
mc project add ~/code/my-app --mode direct-pr   # or no-mistakes, or local-only
mc dispatch --init                   # optional: a place for plain-language dispatch rules
mc commander start                   # launches the Commander and the watcher
mc attach                            # talk to the Commander in its terminal
mc-tui                               # live read-only view of the fleet (q quits)
```

Then tell the Commander what you want.
It plans, spawns pilots, reviews their diffs, and lands the work according to the project mode.

## The cast

- **Commander**: an LLM session in a CLI. It talks to you, plans, and controls everyone else only through `mc`. It never edits your projects.
- **Pilot**: a CLI that implements a change on its own branch in its own worktree.
- **Sentinel**: a CLI that investigates in a read-only checkout and writes a report.
- **Cortana** (optional): a persistent second mate with a scope, a project list and a home of her own. She runs her own crew and answers to the Commander. Local only for now.

## Commands

All commands print JSON, and errors go to stderr with exit code 1.
Run `mc help` for the full list.

| Command | What it does |
| --- | --- |
| `mc project add\|list` | Register the repositories the crew may work on. |
| `mc mission new\|list\|show\|finish` | Build or investigate missions. |
| `mc spawn` | Start a pilot (`--kind ship`) or sentinel (`--kind sentinel`) with a concrete harness, model and effort. |
| `mc status`, `mc send`, `mc teardown` | Inspect, steer and remove an agent. Teardown refuses while work is unlanded. |
| `mc review`, `mc land` | Record a verdict, then deliver an approved branch by project mode. |
| `mc finding add\|list` | Record what held up from an investigation. |
| `mc events` | What changed since you last asked. |
| `mc watch` | The watcher: wakes the Commander only when something needs it. |
| `mc dispatch` | The captain's dispatch rules and the available harnesses. |
| `mc commander`, `mc attach` | Start, stop and attach to the Commander. |
| `mc cortana ...` | Seed, start, route work to, sync and tear down a second mate. |
| `mc afk ...` | Optional away mode. |

## How it works

- **No server.** Commands read and write one SQLite database and tmux, then exit. The only long-lived process is the watcher, plus the optional away daemon.
- **Worktrees.** Each agent gets `.mc/wt/<agent>` on branch `mc/<mission>/<agent>`, with its own ports and temp directory. The worktree creator sits behind a provider interface so a pool-backed one can replace it later.
- **Busy state.** Claude Code reports turn start and end through hooks. For a CLI that cannot, `mc` records the prompt when it sends it. Unknown is never treated as idle or busy.
- **Wakes.** The watcher records `finished`, `blocked`, `stale` and `dead` events and types one short line into the Commander's terminal, only between its turns and never including task text.
- **Landing.** A branch lands only after an approving `mc review`. `local-only` fast-forwards the default branch, and the PR modes push the branch and open a pull request with `gh`.
- **Dispatch.** `config/dispatch.md` holds plain-language rules that the Commander reads. `config/roles.json` sets harness, model and effort per role, resolved mission over project over global, with a `small` tier for short high-volume work.

## Safety model, and its limits

Crew members are isolated by their worktree and screened by a guard hook, not by a sandbox.
Be clear about what that does and does not give you.

- The guard runs before every tool call a Claude Code crew member makes. It blocks file tools outside the worktree (through symlinks too), blocks `cd` out of it, blocks writes by common shell commands outside the allowed area, and refuses delegation tools, `sudo`, `git worktree` and force pushes.
- The shell check is a heuristic. It cannot see what a script or `python -c` does, and `/tmp` stays writable.
- Pilots run in `acceptEdits` mode with explicit allow rules. The `bypassPermissions` flag is opt-in (`--permission-mode`) because it raises a one-time, machine-wide consent dialog that no agent can answer.
- A Codex crew member has no guard at all, because its hook layer must stay off. It is isolated by its worktree alone.
- Agents are never answered at permission or trust dialogs. A stuck agent is reported as `blocked` and left for a person.

## Away mode

`mc afk start` stops the Commander being woken. A separate loop queues each event as either activity or something that needs a person.
It never lands, interrupts, respawns or answers anything.
`mc afk stop` prints a brief and sends the Commander one pointer to it.

## Status

Verified live against real Claude Code: launching in a worktree on plan login, hook-based busy state, the guard hook, and a full Build mission driven by a real Commander and a real pilot.
Not verified live: the Codex adapter, and anything involving `gh` against a real remote (tests use a stub).

Deferred:

- A web deck, on top of an HTTP API added only when a live UI needs one.
- Remote Cortana homes over SSH.
- A pool-backed worktree provider.
- Voice input through OpenWhispr.
- A quota data source for dispatch.
- Whether Cortana keeps veto power over plans and merge gates.
- What the away daemon may decide on its own.
- Anthropic's terms for using plan login with this kind of tool. Check them before relying on it.
