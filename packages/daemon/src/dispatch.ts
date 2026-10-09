import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { McError } from './mc-error.js';

/** Roles that can have a configured harness, model and effort, plus the small-model tier. */
export const CONFIG_KEYS = ['commander', 'cortana', 'pilot', 'sentinel', 'small'] as const;
export type ConfigKey = (typeof CONFIG_KEYS)[number];

export interface RoleSetting {
  harness?: string;
  model?: string;
  effort?: string;
}
export type RoleSettings = Partial<Record<ConfigKey, RoleSetting>>;

export interface RoleConfig {
  global: RoleSettings;
  /** Keyed by project id or path. */
  projects: Record<string, RoleSettings>;
  /** Keyed by mission id. */
  missions: Record<string, RoleSettings>;
}

const EMPTY: RoleConfig = { global: {}, projects: {}, missions: {} };

export const rolesFile = (home: string) => join(home, 'config', 'roles.json');
export const rulesFile = (home: string) => join(home, 'config', 'dispatch.md');

function checkSettings(where: string, value: unknown): RoleSettings {
  if (value === undefined) return {};
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new McError(`${where} must be an object`);
  const out: RoleSettings = {};
  for (const [key, setting] of Object.entries(value)) {
    if (!(CONFIG_KEYS as readonly string[]).includes(key)) {
      throw new McError(`${where}: unknown key "${key}" (use ${CONFIG_KEYS.join(', ')})`);
    }
    if (typeof setting !== 'object' || setting === null || Array.isArray(setting)) throw new McError(`${where}.${key} must be an object`);
    const s: RoleSetting = {};
    for (const [field, v] of Object.entries(setting)) {
      if (field !== 'harness' && field !== 'model' && field !== 'effort') throw new McError(`${where}.${key}: unknown field "${field}"`);
      if (typeof v !== 'string' || !v) throw new McError(`${where}.${key}.${field} must be a non-empty string`);
      s[field] = v;
    }
    out[key as ConfigKey] = s;
  }
  return out;
}

export function parseRoleConfig(text: string, file = 'roles.json'): RoleConfig {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new McError(`${file} is not valid JSON: ${(err as Error).message}`);
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new McError(`${file} must be an object`);
  const obj = raw as Record<string, unknown>;
  for (const k of Object.keys(obj)) {
    if (!['global', 'projects', 'missions'].includes(k)) throw new McError(`${file}: unknown top-level key "${k}"`);
  }
  const scoped = (name: 'projects' | 'missions') => {
    const v = obj[name];
    if (v === undefined) return {};
    if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new McError(`${file}: ${name} must be an object`);
    return Object.fromEntries(Object.entries(v).map(([k, s]) => [k, checkSettings(`${file}: ${name}["${k}"]`, s)]));
  };
  return { global: checkSettings(`${file}: global`, obj.global), projects: scoped('projects'), missions: scoped('missions') };
}

export async function loadRoleConfig(home: string): Promise<RoleConfig> {
  const file = rolesFile(home);
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return EMPTY;
    throw err;
  }
  return parseRoleConfig(text, file);
}

/**
 * The setting for a role: mission overrides project overrides global, field by
 * field. A tier such as "small" layers over the role it replaces the model for.
 */
export function resolveRoleSetting(
  cfg: RoleConfig,
  key: ConfigKey,
  scope: { missionId?: string; projectId?: string; projectPath?: string; tier?: ConfigKey },
): RoleSetting {
  const layers: RoleSettings[] = [
    cfg.global,
    ...(scope.projectId || scope.projectPath ? [cfg.projects[scope.projectId ?? ''] ?? cfg.projects[scope.projectPath ?? ''] ?? {}] : []),
    ...(scope.missionId ? [cfg.missions[scope.missionId] ?? {}] : []),
  ];
  const keys: ConfigKey[] = scope.tier && scope.tier !== key ? [key, scope.tier] : [key];
  const merged: RoleSetting = {};
  for (const k of keys) for (const layer of layers) Object.assign(merged, layer[k]);
  return merged;
}

/** Rules are plain language. A file holding only HTML comments or blanks counts as no rules. */
export function activeRules(text: string): string {
  return text.replace(/<!--[\s\S]*?-->/g, '').trim();
}

export async function readRules(home: string): Promise<{ file: string; text: string; active: boolean }> {
  const file = rulesFile(home);
  const text = await readFile(file, 'utf8').catch(() => '');
  return { file, text, active: activeRules(text).length > 0 };
}

export const STARTER_RULES = `<!--
Write dispatch rules here in plain language. The Commander reads this file when it
plans a task and picks a harness, model and effort for it. Example rules:

- Risky refactors and anything touching auth: strongest model, high effort.
- Quick triage, renames and small fixes: the small model, low effort.
- Investigations: sentinels on a cheaper model unless the bug is subtle.

Delete this comment once you add real rules.
-->
`;
