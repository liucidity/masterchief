import { DatabaseSync } from 'node:sqlite';

const MIGRATIONS = [
  `CREATE TABLE project (
     id TEXT PRIMARY KEY, path TEXT NOT NULL, default_branch TEXT NOT NULL, repo_url TEXT);
   CREATE TABLE mission (
     id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES project(id),
     type TEXT NOT NULL CHECK (type IN ('build','investigate')),
     goal TEXT NOT NULL, status TEXT NOT NULL, branch TEXT NOT NULL, budget REAL);
   CREATE TABLE workspace (
     id TEXT PRIMARY KEY, worktree_path TEXT NOT NULL, branch TEXT NOT NULL,
     base_sha TEXT NOT NULL, access TEXT NOT NULL CHECK (access IN ('rw','ro')));
   CREATE TABLE agent (
     id TEXT PRIMARY KEY, role TEXT NOT NULL, session_id TEXT,
     workspace_id TEXT REFERENCES workspace(id), state TEXT NOT NULL, permanent INTEGER NOT NULL);
   CREATE TABLE task (
     id TEXT PRIMARY KEY, mission_id TEXT NOT NULL REFERENCES mission(id),
     title TEXT NOT NULL, agent_id TEXT REFERENCES agent(id), status TEXT NOT NULL,
     depends_on TEXT NOT NULL DEFAULT '[]');
   CREATE TABLE review (
     id TEXT PRIMARY KEY, mission_id TEXT NOT NULL REFERENCES mission(id),
     by TEXT NOT NULL, verdict TEXT NOT NULL, notes TEXT NOT NULL);
   CREATE TABLE finding (
     id TEXT PRIMARY KEY, mission_id TEXT NOT NULL REFERENCES mission(id),
     claim TEXT NOT NULL, evidence TEXT NOT NULL, confidence REAL NOT NULL);
   CREATE TABLE event (
     id TEXT PRIMARY KEY, mission_id TEXT NOT NULL REFERENCES mission(id),
     agent_id TEXT, kind TEXT NOT NULL, payload TEXT NOT NULL, ts INTEGER NOT NULL);`,
  `ALTER TABLE project ADD COLUMN delivery_mode TEXT NOT NULL DEFAULT 'direct-pr'
     CHECK (delivery_mode IN ('no-mistakes','direct-pr','local-only'));
   ALTER TABLE task ADD COLUMN kind TEXT NOT NULL DEFAULT 'ship' CHECK (kind IN ('ship','sentinel'));
   ALTER TABLE task ADD COLUMN delivery_mode TEXT NOT NULL DEFAULT 'direct-pr'
     CHECK (delivery_mode IN ('no-mistakes','direct-pr','local-only'));
   ALTER TABLE agent ADD COLUMN harness TEXT NOT NULL DEFAULT 'claude';
   ALTER TABLE agent ADD COLUMN model TEXT;
   ALTER TABLE agent ADD COLUMN effort TEXT;
   ALTER TABLE agent ADD COLUMN endpoint TEXT;
   ALTER TABLE agent DROP COLUMN session_id;
   UPDATE agent SET role = CASE role
     WHEN 'engineer' THEN 'pilot' WHEN 'tester' THEN 'pilot' WHEN 'reviewer' THEN 'pilot'
     WHEN 'investigator' THEN 'sentinel' ELSE role END;
   UPDATE agent SET state = CASE state
     WHEN 'working' THEN 'busy' WHEN 'waiting' THEN 'idle' WHEN 'done' THEN 'retired'
     WHEN 'failed' THEN 'dead' ELSE state END;
   UPDATE review SET by = 'commander' WHERE by = 'reviewer';
   CREATE TABLE event_new (
     id TEXT PRIMARY KEY, mission_id TEXT REFERENCES mission(id),
     agent_id TEXT, kind TEXT NOT NULL, payload TEXT NOT NULL, ts INTEGER NOT NULL);
   INSERT INTO event_new SELECT id, mission_id, agent_id, kind, payload, ts FROM event;
   DROP TABLE event;
   ALTER TABLE event_new RENAME TO event;
   CREATE TABLE setting (key TEXT PRIMARY KEY, value TEXT NOT NULL);
   CREATE TABLE cortana_home (
     id TEXT PRIMARY KEY, scope TEXT NOT NULL, projects TEXT NOT NULL DEFAULT '[]',
     home_path TEXT NOT NULL, route TEXT NOT NULL CHECK (route IN ('local')), harness TEXT);`,
  `ALTER TABLE agent ADD COLUMN gen TEXT;
   ALTER TABLE agent ADD COLUMN hook_log TEXT;
   ALTER TABLE agent ADD COLUMN slot INTEGER;`,
  `CREATE UNIQUE INDEX agent_slot_unique ON agent(slot) WHERE slot IS NOT NULL;`,
  `ALTER TABLE review ADD COLUMN task_id TEXT REFERENCES task(id);`,
  `CREATE TABLE afk_item (
     id TEXT PRIMARY KEY, event_seq INTEGER NOT NULL UNIQUE, kind TEXT NOT NULL,
     needs_human INTEGER NOT NULL, agent_id TEXT, task_id TEXT, summary TEXT NOT NULL,
     detail TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL, archived_at INTEGER);`,
];

export function openDb(path = ':memory:'): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA foreign_keys = ON');
  // Several mc processes and the watcher share this file.
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec('PRAGMA journal_mode = WAL');
  const row = db.prepare('PRAGMA user_version').get() as { user_version: number };
  for (let v = row.user_version; v < MIGRATIONS.length; v++) {
    db.exec('BEGIN');
    db.exec(MIGRATIONS[v]!);
    db.exec(`PRAGMA user_version = ${v + 1}`);
    db.exec('COMMIT');
  }
  return db;
}
