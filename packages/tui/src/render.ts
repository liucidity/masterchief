import type { AlertRow, CortanaRow, CrewRow, MissionRow, Snapshot } from './snapshot.js';

export interface RenderOptions {
  width: number;
  height: number;
  color: boolean;
  /** Show finished and aborted missions too. */
  showAll: boolean;
}

const ESC = '\x1b[';
const styles = {
  bold: [1, 22],
  dim: [2, 22],
  red: [31, 39],
  green: [32, 39],
  yellow: [33, 39],
  blue: [34, 39],
  cyan: [36, 39],
} as const;
type Style = keyof typeof styles;

const paint = (on: boolean, style: Style | Style[], text: string) => {
  if (!on || !text) return text;
  return [style].flat().reduce((t, s) => `${ESC}${styles[s][0]}m${t}${ESC}${styles[s][1]}m`, text);
};

/** Cut a styled line to a width, keeping its colour codes balanced. */
export function clip(line: string, width: number): string {
  if (visibleLength(line) <= width) return line;
  let out = '';
  let seen = 0;
  for (let i = 0; i < line.length && seen < width - 1; ) {
    const m = /^\x1b\[[0-9;]*m/.exec(line.slice(i));
    if (m) {
      out += m[0];
      i += m[0].length;
    } else {
      out += line[i];
      seen++;
      i++;
    }
  }
  return `${out}…${line.includes('\x1b[') ? `${ESC}0m` : ''}`;
}

/** Visible length, ignoring colour codes. */
export const visibleLength = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '').length;

const fit = (text: string, width: number) => {
  if (width <= 0) return '';
  if (text.length <= width) return text.padEnd(width);
  return `${text.slice(0, Math.max(0, width - 1))}…`;
};

export function age(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

const clock = (ms: number) => new Date(ms).toTimeString().slice(0, 8);

interface Column<T> {
  title: string;
  /** Fixed width, or a flex weight when `flex` is set. */
  width: number;
  flex?: boolean;
  /** Hide this column when the terminal is narrower than this. */
  hideBelow?: number;
  text: (row: T) => string;
  style?: (row: T) => Style | Style[] | undefined;
}

const INDENT = 2;
const GAP = 2;

function table<T>(cols: Column<T>[], rows: T[], o: RenderOptions): { head: string; rows: string[] } {
  const shown = cols.filter((c) => !c.hideBelow || o.width >= c.hideBelow);
  const room = o.width - INDENT - GAP * (shown.length - 1);
  const fixed = shown.filter((c) => !c.flex).reduce((n, c) => n + c.width, 0);
  const weights = shown.filter((c) => c.flex).reduce((n, c) => n + c.width, 0);
  const left = Math.max(0, room - fixed);
  const widths = shown.map((c) => (c.flex ? Math.max(6, Math.floor((left * c.width) / weights)) : c.width));
  const line = (cells: string[]) => `${' '.repeat(INDENT)}${cells.join(' '.repeat(GAP))}`.trimEnd();
  const head = line(shown.map((c, i) => paint(o.color, 'dim', fit(c.title, widths[i]!))));
  const body = rows.map((r) =>
    line(
      shown.map((c, i) => {
        const cell = fit(c.text(r), widths[i]!);
        const st = c.style?.(r);
        return st ? paint(o.color, st, cell) : cell;
      }),
    ),
  );
  return { head, rows: body };
}

const STATE_GLYPH: Record<string, string> = { busy: '●', waiting: '!', idle: '○', starting: '◌', unknown: '?', dead: '×', stopped: '·', retired: '·' };
const stateText = (s: string) => `${STATE_GLYPH[s] ?? '?'} ${s}`;
const stateStyle = (s: string): Style | Style[] | undefined =>
  ({ busy: 'green', waiting: 'yellow', idle: 'cyan', starting: 'yellow', unknown: 'yellow', dead: 'red', stopped: 'dim' } as Record<string, Style>)[s];

const missionStyle = (s: MissionRow['status']): Style | undefined =>
  ({ running: 'green', blocked: 'yellow', paused: 'yellow', planning: 'cyan', done: 'dim', aborted: 'dim' } as Record<string, Style>)[s];
const alertStyle = (k: string): Style | Style[] | undefined =>
  ({ blocked: 'yellow', dead: 'red', stale: 'yellow', finished: 'cyan', landed: 'green' } as Record<string, Style>)[k];

const ACTIVE = new Set(['planning', 'running', 'blocked', 'paused']);

interface Section {
  header: string;
  /** Column heads, absent for an empty section. */
  head?: string;
  rows: string[];
  /** Shown instead of rows when there are none. */
  empty?: string;
  /** What to call the rows that did not fit, e.g. "older". */
  more: string;
  /** Extra rows to rank last in the list, shown only if room allows. */
  footnote?: string;
}

/** Lines a section takes when it shows `visible` of its rows. */
function cost(s: Section, visible: number, compact: boolean): number {
  if (!s.rows.length) return 1 + 1;
  const hidden = s.rows.length - visible;
  return 1 + (compact ? 0 : 1) + visible + (hidden > 0 ? 1 : s.footnote ? 1 : 0);
}

/** Lay the snapshot out for a terminal of the given size. Pure, so it can be tested without one. */
export function render(s: Snapshot, o: RenderOptions): string[] {
  const rule = paint(o.color, 'dim', '─'.repeat(o.width));
  const header = (name: string, count: number | string, note = '') => `${paint(o.color, 'bold', name)} ${paint(o.color, 'dim', `${count}${note}`)}`;
  const note = (text: string) => `  ${paint(o.color, 'dim', text)}`;

  const title = ` ${paint(o.color, ['bold', 'cyan'], 'MasterChief')}`;
  const time = `${clock(s.now)} `;
  const top = [`${title}${' '.repeat(Math.max(1, o.width - ' MasterChief'.length - time.length))}${paint(o.color, 'dim', time)}`];
  const watcher = s.watcher.running ? paint(o.color, 'green', `● watching (pid ${s.watcher.pid})`) : paint(o.color, 'red', '× watcher not running');
  const afk = s.afk.active
    ? paint(o.color, 'yellow', `● away ${s.afk.since ? age(s.now - s.afk.since).replace(' ago', '') : ''}, ${s.afk.queued} queued, ${s.afk.needYou} need you`)
    : paint(o.color, 'dim', '○ away mode off');
  top.push(` ${watcher}   ${afk}`, rule);

  const missionsSorted = [...s.missions].sort((a, b) => Number(ACTIVE.has(b.status)) - Number(ACTIVE.has(a.status)));
  const visibleMissions = o.showAll ? missionsSorted : missionsSorted.filter((m) => ACTIVE.has(m.status));
  const hiddenMissions = s.missions.length - visibleMissions.length;

  const missions = table<MissionRow>(
    [
      { title: 'ID', width: 8, text: (m) => m.id.slice(0, 8) },
      { title: 'TYPE', width: 11, hideBelow: 72, text: (m) => m.type },
      { title: 'STATUS', width: 8, text: (m) => m.status, style: (m) => missionStyle(m.status) },
      { title: 'TASKS', width: 5, text: (m) => `${m.done}/${m.total}` },
      { title: 'GOAL', width: 1, flex: true, text: (m) => m.goal },
    ],
    visibleMissions,
    o,
  );
  const crew = table<CrewRow>(
    [
      { title: 'AGENT', width: 16, text: (a) => a.id },
      { title: 'ROLE', width: 9, text: (a) => a.role },
      { title: 'ENGINE', width: 24, hideBelow: 96, text: (a) => [a.harness, a.model, a.effort].filter(Boolean).join(' ') },
      { title: 'STATE', width: 10, text: (a) => stateText(a.state), style: (a) => stateStyle(a.state) },
      { title: 'TASK', width: 1, flex: true, text: (a) => a.task ?? '' },
    ],
    s.crew,
    o,
  );
  const cortana = table<CortanaRow>(
    [
      { title: 'ID', width: 14, text: (c) => c.id },
      { title: 'STATE', width: 10, text: (c) => stateText(c.state), style: (c) => stateStyle(c.state) },
      { title: 'CREW', width: 4, text: (c) => (c.crew === null ? '-' : String(c.crew)) },
      { title: 'SCOPE', width: 1, flex: true, text: (c) => c.scope },
    ],
    s.cortana,
    o,
  );
  const alerts = table<AlertRow>(
    [
      { title: 'WHEN', width: 8, text: (a) => age(s.now - a.at) },
      { title: 'KIND', width: 8, text: (a) => a.kind, style: (a) => alertStyle(a.kind) },
      { title: 'AGENT', width: 16, hideBelow: 64, text: (a) => a.agent ?? '' },
      { title: 'WHAT', width: 1, flex: true, text: (a) => a.text },
    ],
    s.alerts,
    o,
  );

  // Ordered by priority for spare rows: what needs attention first.
  const sections: Section[] = [
    { header: header('ALERTS', s.alerts.length), head: alerts.head, rows: alerts.rows, empty: note('nothing yet'), more: 'older' },
    { header: header('CREW', s.crew.length, ' live'), head: crew.head, rows: crew.rows, empty: note('no live agents'), more: 'more' },
    {
      header: header('MISSIONS', s.missions.filter((m) => ACTIVE.has(m.status)).length, ' active'),
      head: missions.head,
      rows: missions.rows,
      empty: note(hiddenMissions ? `none active (${hiddenMissions} finished, press a)` : 'none yet'),
      more: 'more',
      footnote: visibleMissions.length && hiddenMissions ? note(`+${hiddenMissions} finished (press a)`) : undefined,
    },
    ...(s.cortana.length ? [{ header: header('CORTANA', s.cortana.length), head: cortana.head, rows: cortana.rows, more: 'more' } as Section] : []),
  ];

  // Fit the height: show one row of everything if possible, else drop heads and blanks,
  // else drop the least important sections, then hand out spare rows.
  const avail = o.height - top.length - 2;
  const smallest = (n: number) => sections.slice(0, n).reduce((sum, sec) => sum + cost(sec, Math.min(1, sec.rows.length), true), 0);
  let kept = sections.length;
  while (kept > 1 && smallest(kept) > avail) kept--;
  sections.length = kept;
  const total = (vis: number[], compact: boolean) => sections.reduce((n, sec, i) => n + cost(sec, vis[i]!, compact), 0) + (compact ? 0 : sections.length - 1);
  const visible = sections.map((sec) => Math.min(1, sec.rows.length));
  const compact = total(visible, false) > avail;
  for (let grew = true; grew; ) {
    grew = false;
    for (let i = 0; i < sections.length; i++) {
      if (visible[i]! >= sections[i]!.rows.length) continue;
      const next = [...visible];
      next[i]!++;
      if (total(next, compact) <= avail) {
        visible[i] = next[i]!;
        grew = true;
      }
    }
  }

  const body: string[] = [];
  const order = ['MISSIONS', 'CREW', 'CORTANA', 'ALERTS'];
  const placed = [...sections.keys()].sort((a, b) => order.findIndex((n) => sections[a]!.header.includes(n)) - order.findIndex((n) => sections[b]!.header.includes(n)));
  placed.forEach((i, n) => {
    const sec = sections[i]!;
    if (n > 0 && !compact) body.push('');
    body.push(sec.header);
    if (!sec.rows.length) return void body.push(sec.empty ?? '');
    if (!compact) body.push(sec.head!);
    body.push(...sec.rows.slice(0, visible[i]!));
    const hidden = sec.rows.length - visible[i]!;
    if (hidden > 0) body.push(note(`+${hidden} ${sec.more}`));
    else if (sec.footnote) body.push(sec.footnote);
  });

  const footerText = o.width >= 52 ? ` q quit   r refresh   a ${o.showAll ? 'hide' : 'show'} finished missions` : ' q quit  r refresh  a finished';
  const footer = paint(o.color, 'dim', footerText);
  const lines = [...top, ...body];
  while (lines.length < o.height - 2) lines.push('');
  lines.splice(o.height - 2);
  lines.push(rule, footer);
  return lines.map((l) => clip(l, o.width));
}

/** Split a row budget between lists, giving every list at least two rows when it can. */
export function shareRows(budget: number, wanted: number[]): number[] {
  const caps = wanted.map((w) => Math.min(w, 2));
  let left = budget - caps.reduce((a, b) => a + b, 0);
  for (let round = 0; left > 0 && round < 1000; round++) {
    let gave = false;
    for (let i = 0; i < caps.length && left > 0; i++) {
      if (caps[i]! < wanted[i]!) {
        caps[i]!++;
        left--;
        gave = true;
      }
    }
    if (!gave) break;
  }
  return caps;
}
