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

/** Applied in order; PRAGMA user_version records how many have run. */
const MIGRATIONS = [
  // 1: attachments, keyword auto-replies, call-back requests, settings, manually added contacts
  `
  CREATE TABLE media (
    id             INTEGER PRIMARY KEY,
    filename       TEXT    NOT NULL,
    mime_type      TEXT    NOT NULL,
    size           INTEGER NOT NULL,
    kind           TEXT    NOT NULL CHECK (kind IN ('image', 'video', 'document')),
    storage_path   TEXT    NOT NULL,
    wa_media_id    TEXT,
    wa_uploaded_at INTEGER,
    created_at     INTEGER NOT NULL
  );

  CREATE TABLE auto_replies (
    id          INTEGER PRIMARY KEY,
    keyword     TEXT    NOT NULL UNIQUE,
    action      TEXT    NOT NULL CHECK (action IN ('reply', 'handoff')),
    reply_text  TEXT    NOT NULL DEFAULT '',
    media_id    INTEGER REFERENCES media(id),
    enabled     INTEGER NOT NULL DEFAULT 1,
    hit_count   INTEGER NOT NULL DEFAULT 0,
    last_hit_at INTEGER,
    created_at  INTEGER NOT NULL
  );

  CREATE TABLE handoffs (
    id            INTEGER PRIMARY KEY,
    subscriber_id INTEGER NOT NULL REFERENCES subscribers(id) ON DELETE CASCADE,
    message       TEXT    NOT NULL DEFAULT '',
    status        TEXT    NOT NULL CHECK (status IN ('open', 'done')),
    notify_status TEXT    NOT NULL CHECK (notify_status IN ('sent', 'failed', 'not_configured')),
    notify_error  TEXT,
    created_at    INTEGER NOT NULL,
    resolved_at   INTEGER
  );

  CREATE TABLE settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  ALTER TABLE memberships ADD COLUMN source TEXT NOT NULL DEFAULT 'whatsapp';
  ALTER TABLE messages ADD COLUMN media_id INTEGER REFERENCES media(id);
  ALTER TABLE inbound_messages ADD COLUMN handled_as TEXT NOT NULL DEFAULT '';
  CREATE INDEX inbound_by_sender ON inbound_messages(wa_id, received_at);
  `,
];

export type Database = DatabaseSync;

export function openDatabase(path: string): Database {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  if (path !== ':memory:') db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA);
  migrate(db);
  return db;
}

function migrate(db: Database): void {
  const { user_version: version } = db.prepare('PRAGMA user_version').get() as { user_version: number };
  for (let i = version; i < MIGRATIONS.length; i++) {
    transaction(db, () => {
      db.exec(MIGRATIONS[i]);
      db.exec(`PRAGMA user_version = ${i + 1}`);
    });
  }
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
