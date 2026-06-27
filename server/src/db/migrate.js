import db from './index.js';

/**
 * Lightweight migration runner. Each migration is applied in order and the
 * highest applied index is stored in SQLite's `user_version` pragma, so the
 * set only ever runs forward and never re-applies on restart.
 */
const migrations = [
  // 0001 — accounts
  (d) => {
    d.exec(`
      CREATE TABLE users (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        email         TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        display_name  TEXT,
        created_at    TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
  },

  // 0002 — papers + full-text search
  (d) => {
    d.exec(`
      CREATE TABLE papers (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        external_id TEXT UNIQUE,
        title       TEXT NOT NULL,
        abstract    TEXT,
        authors     TEXT,
        url         TEXT,
        published_at TEXT,
        created_at  TEXT NOT NULL DEFAULT (datetime('now'))
      );

      -- External-content FTS5 index over papers(title, abstract, authors).
      CREATE VIRTUAL TABLE papers_fts USING fts5(
        title, abstract, authors,
        content='papers',
        content_rowid='id'
      );

      -- Triggers keep the FTS index in sync with the papers table.
      CREATE TRIGGER papers_ai AFTER INSERT ON papers BEGIN
        INSERT INTO papers_fts(rowid, title, abstract, authors)
        VALUES (new.id, new.title, new.abstract, new.authors);
      END;

      CREATE TRIGGER papers_ad AFTER DELETE ON papers BEGIN
        INSERT INTO papers_fts(papers_fts, rowid, title, abstract, authors)
        VALUES('delete', old.id, old.title, old.abstract, old.authors);
      END;

      CREATE TRIGGER papers_au AFTER UPDATE ON papers BEGIN
        INSERT INTO papers_fts(papers_fts, rowid, title, abstract, authors)
        VALUES('delete', old.id, old.title, old.abstract, old.authors);
        INSERT INTO papers_fts(rowid, title, abstract, authors)
        VALUES (new.id, new.title, new.abstract, new.authors);
      END;
    `);
  },

  // 0003 — users: public uid + rename display_name -> name
  (d) => {
    d.exec(`
      ALTER TABLE users RENAME COLUMN display_name TO name;
      ALTER TABLE users ADD COLUMN uid TEXT;
    `);
    // Backfill uid for any existing rows, then enforce uniqueness.
    const rows = d.prepare('SELECT id FROM users WHERE uid IS NULL').all();
    const setUid = d.prepare('UPDATE users SET uid = ? WHERE id = ?');
    for (const { id } of rows) {
      setUid.run(genUid(), id);
    }
    d.exec('CREATE UNIQUE INDEX idx_users_uid ON users(uid);');
  },

  // 0004 — keyword subscriptions + per-user paper state (saved/dismissed)
  (d) => {
    d.exec(`
      CREATE TABLE subscriptions (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        keyword    TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      -- Keywords are stored normalized (trimmed, lowercased) so this unique
      -- index also enforces case-insensitive de-duplication per user.
      CREATE UNIQUE INDEX idx_subscriptions_user_keyword
        ON subscriptions(user_id, keyword);
      CREATE INDEX idx_subscriptions_user ON subscriptions(user_id);

      -- A user's relationship to a paper in their digest. Absence of a row
      -- means "untouched"; a row is either 'saved' or 'dismissed'.
      CREATE TABLE user_papers (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        paper_id   INTEGER NOT NULL REFERENCES papers(id) ON DELETE CASCADE,
        state      TEXT NOT NULL CHECK (state IN ('saved', 'dismissed')),
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE UNIQUE INDEX idx_user_papers_user_paper
        ON user_papers(user_id, paper_id);
      CREATE INDEX idx_user_papers_user_state ON user_papers(user_id, state);
    `);
  },
];

import { randomUUID } from 'node:crypto';

// Public-facing user identifier. Random so the integer PK never leaks.
function genUid() {
  return randomUUID();
}

export function migrate() {
  const current = db.pragma('user_version', { simple: true });

  for (let version = current; version < migrations.length; version++) {
    const run = migrations[version];
    const tx = db.transaction(() => {
      run(db);
      // user_version can't be parameterized; version is a controlled integer.
      db.pragma(`user_version = ${version + 1}`);
    });
    tx();
    console.log(`Applied migration ${String(version + 1).padStart(4, '0')}`);
  }

  return db.pragma('user_version', { simple: true });
}
