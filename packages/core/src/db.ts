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
];

export function openDb(path = ':memory:'): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA foreign_keys = ON');
  const row = db.prepare('PRAGMA user_version').get() as { user_version: number };
  for (let v = row.user_version; v < MIGRATIONS.length; v++) {
    db.exec('BEGIN');
    db.exec(MIGRATIONS[v]!);
    db.exec(`PRAGMA user_version = ${v + 1}`);
    db.exec('COMMIT');
  }
  return db;
}
