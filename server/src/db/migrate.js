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

  // 0005 — curated keyword library + custom-keyword flag
  (d) => {
    d.exec(`
      CREATE TABLE keywords_library (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        keyword    TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      -- Flag a subscription as a user-created ("custom") keyword vs one chosen
      -- from the library. Decided at insert time and frozen, so the per-user
      -- custom cap stays stable even if the library changes later.
      ALTER TABLE subscriptions ADD COLUMN is_custom INTEGER NOT NULL DEFAULT 0;
    `);

    // Seed the library. Keywords are pre-normalized (trimmed, lowercased) to
    // match the normalizeKeyword() form used when subscribing.
    const seed = [
      'machine learning',
      'deep learning',
      'computer vision',
      'natural language processing',
      'reinforcement learning',
      'transformers',
      'large language models',
      'diffusion models',
      'graph neural networks',
      'generative models',
      'quantum computing',
      'robotics',
      'optimization',
      'federated learning',
      'self-supervised learning',
      'multimodal learning',
      'speech recognition',
      'recommender systems',
      'time series',
      'causal inference',
    ];
    const insLib = d.prepare('INSERT INTO keywords_library (keyword) VALUES (?)');
    for (const k of seed) insLib.run(k);

    // Backfill: any existing subscription whose keyword isn't in the library is
    // a custom keyword.
    d.exec(`
      UPDATE subscriptions SET is_custom = 1
      WHERE keyword NOT IN (SELECT keyword FROM keywords_library);
    `);
  },

  // 0006 — keywords become a shared library contributed by users
  (d) => {
    // Attribute library keywords to their author. NULL = system/seeded. On user
    // deletion the keyword stays in the shared library but loses attribution.
    d.exec(`
      ALTER TABLE keywords_library
        ADD COLUMN created_by INTEGER REFERENCES users(id) ON DELETE SET NULL;
      CREATE INDEX idx_keywords_library_created_by ON keywords_library(created_by);
    `);

    // Migrate previously-private custom keywords into the shared library,
    // attributed to the user who first introduced them. INSERT OR IGNORE guards
    // the rare case where two users coined the same custom keyword.
    d.exec(`
      INSERT OR IGNORE INTO keywords_library (keyword, created_by)
      SELECT keyword, MIN(user_id) FROM subscriptions
      WHERE is_custom = 1 GROUP BY keyword;
    `);

    // Authorship now lives on the library, so the per-subscription flag is
    // redundant. Derive "custom" via a join to keywords_library instead.
    d.exec('ALTER TABLE subscriptions DROP COLUMN is_custom;');
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
