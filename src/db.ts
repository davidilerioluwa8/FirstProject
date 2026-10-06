import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS lists (
  id              INTEGER PRIMARY KEY,
  name            TEXT    NOT NULL,
  slug            TEXT    NOT NULL UNIQUE,
  description     TEXT    NOT NULL DEFAULT '',
  welcome_message TEXT    NOT NULL DEFAULT '',
  created_at      INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS subscribers (
  id              INTEGER PRIMARY KEY,
  wa_id           TEXT    NOT NULL UNIQUE,
  name            TEXT    NOT NULL DEFAULT '',
  last_inbound_at INTEGER,
  created_at      INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS memberships (
  list_id         INTEGER NOT NULL REFERENCES lists(id) ON DELETE CASCADE,
  subscriber_id   INTEGER NOT NULL REFERENCES subscribers(id) ON DELETE CASCADE,
  status          TEXT    NOT NULL CHECK (status IN ('active', 'unsubscribed')),
  opted_in_at     INTEGER NOT NULL,
  unsubscribed_at INTEGER,
  PRIMARY KEY (list_id, subscriber_id)
);

CREATE TABLE IF NOT EXISTS messages (
  id                INTEGER PRIMARY KEY,
  list_id           INTEGER NOT NULL REFERENCES lists(id) ON DELETE CASCADE,
  kind              TEXT    NOT NULL CHECK (kind IN ('template', 'text')),
  template_name     TEXT,
  template_language TEXT,
  template_params   TEXT    NOT NULL DEFAULT '[]',
  body              TEXT,
  send_at           INTEGER NOT NULL,
  status            TEXT    NOT NULL CHECK (status IN ('scheduled', 'sending', 'sent', 'cancelled', 'failed')),
  created_at        INTEGER NOT NULL,
  started_at        INTEGER,
  finished_at       INTEGER
);
CREATE INDEX IF NOT EXISTS messages_due ON messages(status, send_at);

CREATE TABLE IF NOT EXISTS deliveries (
  id            INTEGER PRIMARY KEY,
  message_id    INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  subscriber_id INTEGER NOT NULL REFERENCES subscribers(id) ON DELETE CASCADE,
  wamid         TEXT,
  status        TEXT    NOT NULL CHECK (status IN ('pending', 'accepted', 'sent', 'delivered', 'read', 'failed', 'skipped')),
  error         TEXT,
  updated_at    INTEGER NOT NULL,
  UNIQUE (message_id, subscriber_id)
);
CREATE INDEX IF NOT EXISTS deliveries_wamid ON deliveries(wamid);

CREATE TABLE IF NOT EXISTS inbound_messages (
  id          INTEGER PRIMARY KEY,
  wamid       TEXT    NOT NULL UNIQUE,
  wa_id       TEXT    NOT NULL,
  type        TEXT    NOT NULL,
  text        TEXT    NOT NULL DEFAULT '',
  received_at INTEGER NOT NULL
);
`;

export type Database = DatabaseSync;

export function openDatabase(path: string): Database {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  if (path !== ':memory:') db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA);
  return db;
}

export function transaction<T>(db: Database, fn: () => T): T {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}
