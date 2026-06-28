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

  // 0007 — daily digest archive: per-day scopes and their selected papers.
  // Mirrors the archive/*.json shape from the Don_daily_paper_report generator:
  // a paper's intrinsic fields live on `papers` (deduped by external_id), while
  // everything that varies per scope (tag, tldr, position, zh_summary,
  // highlights, code, ranking) lives on `scope_papers` — because the same paper
  // appears under multiple scopes the same day with different enrichment.
  (d) => {
    d.exec(`
      -- Intrinsic paper fields missing from the original papers table.
      ALTER TABLE papers ADD COLUMN pdf_url TEXT;
      ALTER TABLE papers ADD COLUMN github  TEXT;

      -- One row per (date, scope). Holds the scope's config snapshot as used
      -- that day, since the generator records config per-day and it can drift.
      CREATE TABLE daily_scopes (
        id                  INTEGER PRIMARY KEY AUTOINCREMENT,
        digest_date         TEXT NOT NULL,          -- 'YYYY-MM-DD'
        name                TEXT NOT NULL,          -- scope.name
        queries             TEXT,                   -- JSON array of query strings
        interests           TEXT,
        top_n               INTEGER,
        push_n              INTEGER,
        max_candidates      INTEGER,
        query_delay_seconds INTEGER,
        same_day_only       INTEGER,                -- 0/1
        lookback_days       INTEGER,
        dedup_days          INTEGER,
        created_at          TEXT NOT NULL DEFAULT (datetime('now'))
      );

      -- A scope name is unique within a given day.
      CREATE UNIQUE INDEX idx_daily_scopes_date_name
        ON daily_scopes(digest_date, name);
      CREATE INDEX idx_daily_scopes_date ON daily_scopes(digest_date);

      -- Membership: which papers fell under a daily scope, with the
      -- scope-relative enrichment and the order they were presented in.
      CREATE TABLE scope_papers (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        daily_scope_id INTEGER NOT NULL REFERENCES daily_scopes(id) ON DELETE CASCADE,
        paper_id      INTEGER NOT NULL REFERENCES papers(id) ON DELETE CASCADE,
        rank          INTEGER NOT NULL DEFAULT 0,   -- position within the scope
        tag           TEXT,
        tldr          TEXT,
        position      TEXT,
        zh_summary    TEXT,
        highlights    TEXT,                         -- JSON array of strings
        code          TEXT,
        created_at    TEXT NOT NULL DEFAULT (datetime('now'))
      );

      -- A paper appears at most once per daily scope.
      CREATE UNIQUE INDEX idx_scope_papers_scope_paper
        ON scope_papers(daily_scope_id, paper_id);
      CREATE INDEX idx_scope_papers_paper ON scope_papers(paper_id);
    `);
  },

  // 0008 — scopes become the subscribable unit.
  //
  // Previously a "subscription" pointed at a free-text keyword (matched against
  // papers via FTS) while the curated `daily_scopes` were never served. This
  // migration unifies the two: a `scopes` catalog holds the collection rule
  // (name + arXiv queries + interests), users subscribe to a scope by id, and
  // the daily feed is the curated membership of the scopes they follow.
  //
  // The catalog is seeded to mirror the generator's default config
  // (Don_daily_paper_report/config.example.json) so subscribing to a scope name
  // lines up with the `daily_scopes.name` rows already imported from the
  // archive. The seed array is inlined to avoid a cross-repo file read at
  // migration time — keep it in sync with that config if the defaults change.
  (d) => {
    d.exec(`
      CREATE TABLE scopes (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        name       TEXT NOT NULL UNIQUE,
        queries    TEXT NOT NULL,          -- JSON array of arXiv query strings
        interests  TEXT,
        -- NULL = seeded/system scope; otherwise the user who authored it. On
        -- user deletion the scope stays in the shared catalog, unattributed.
        created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX idx_scopes_created_by ON scopes(created_by);
    `);

    const seed = [
      {
        name: '具身智能综合',
        queries: [
          'cat:cs.RO',
          'all:embodied',
          'all:vision AND all:language AND all:action',
          'all:robot AND all:manipulation',
        ],
        interests: 'Embodied AI, generalist robot policy, robot learning',
      },
      {
        name: 'VLA与机器人基础模型',
        queries: [
          'all:vision AND all:language AND all:action',
          'all:robot AND all:foundation AND all:model',
          'all:multimodal AND all:robot',
        ],
        interests: 'VLA, robot foundation model, multimodal policy',
      },
      {
        name: '遥操作与示教',
        queries: [
          'all:teleoperation AND all:robot',
          'all:remote AND all:operation AND all:robot',
          'all:human AND all:demonstration AND all:robot',
          'all:learning AND all:demonstration AND all:robot',
        ],
        interests:
          'teleoperation, human demonstration, learning from demonstration, robot teaching',
      },
      {
        name: '灵巧手与操作',
        queries: [
          'all:dexterous AND all:manipulation',
          'all:dexterous AND all:hand',
          'all:robot AND all:manipulation',
          'all:grasping',
        ],
        interests: 'dexterous hand, manipulation, grasping',
      },
      {
        name: '世界模型与规划',
        queries: [
          'all:world AND all:model AND all:robot',
          'all:video AND all:prediction AND all:robot',
          'all:model AND all:based AND all:robot AND all:learning',
          'all:planning AND all:embodied',
        ],
        interests:
          'world model, planning, model-based robot learning, video prediction',
      },
      {
        name: '模仿学习与Sim2Real',
        queries: [
          'all:imitation AND all:learning AND all:robot',
          'all:behavior AND all:cloning AND all:robot',
          'all:sim AND all:real AND all:robot',
          'all:domain AND all:randomization AND all:robot',
        ],
        interests:
          'imitation learning, behavior cloning, sim-to-real, domain adaptation',
      },
      {
        name: '机器人数据集与评测',
        queries: [
          'all:robot AND all:dataset',
          'all:robotics AND all:benchmark',
          'all:embodied AND all:benchmark',
          'all:evaluation AND all:robot AND all:learning',
        ],
        interests: 'robot dataset, benchmark, evaluation, reproducibility',
      },
    ];
    const insScope = d.prepare(
      'INSERT INTO scopes (name, queries, interests) VALUES (@name, @queries, @interests)'
    );
    for (const sc of seed) {
      insScope.run({
        name: sc.name,
        queries: JSON.stringify(sc.queries),
        interests: sc.interests ?? null,
      });
    }

    // Adopt any scope names already present in the imported archive that the
    // seed didn't cover (e.g. an alternate config). Their collection rule comes
    // from the most recent daily_scopes snapshot for that name.
    d.exec(`
      INSERT OR IGNORE INTO scopes (name, queries, interests)
      SELECT name,
             COALESCE(queries, '[]'),
             interests
      FROM daily_scopes ds
      WHERE ds.id = (
        SELECT MAX(id) FROM daily_scopes WHERE name = ds.name
      );
    `);

    // Repoint subscriptions from free-text keyword -> scope_id. Rebuild the
    // table because SQLite can't drop the NOT NULL keyword column while keeping
    // its data, and we want a clean (user_id, scope_id) shape.
    d.exec(`
      CREATE TABLE subscriptions_new (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        scope_id   INTEGER NOT NULL REFERENCES scopes(id) ON DELETE CASCADE,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      -- Carry over only subscriptions whose keyword matches a known scope name;
      -- legacy free-text keywords with no matching scope are dropped.
      INSERT OR IGNORE INTO subscriptions_new (user_id, scope_id, created_at)
      SELECT sub.user_id, sc.id, sub.created_at
      FROM subscriptions sub
      JOIN scopes sc ON sc.name = sub.keyword;

      DROP TABLE subscriptions;
      ALTER TABLE subscriptions_new RENAME TO subscriptions;

      CREATE UNIQUE INDEX idx_subscriptions_user_scope
        ON subscriptions(user_id, scope_id);
      CREATE INDEX idx_subscriptions_user ON subscriptions(user_id);

      -- The free-text keyword library is obsolete now that scopes are the
      -- subscribable unit.
      DROP TABLE IF EXISTS keywords_library;
    `);
  },

  // 0009 — per-user push settings. Each user decides whether to receive the
  // daily digest by email (to their account address) and/or Bark (to their own
  // device key). Transport creds (SMTP login, Bark server) stay operator-level
  // config; only the recipient-facing toggles + Bark key live here.
  (d) => {
    d.exec(`
      ALTER TABLE users ADD COLUMN email_push_enabled INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE users ADD COLUMN bark_push_enabled  INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE users ADD COLUMN bark_key           TEXT;
    `);
  },

  // 0010 — email-push confirmation tokens. Turning email push ON now requires
  // the user to click a one-time link mailed to their account address (proving
  // the address actually receives mail before we start sending digests). Each
  // token is single-use and time-limited; turning push OFF needs no token.
  (d) => {
    d.exec(`
      CREATE TABLE email_push_tokens (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        token      TEXT NOT NULL UNIQUE,
        user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        expires_at TEXT NOT NULL,
        used_at    TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX idx_email_push_tokens_user ON email_push_tokens(user_id);
    `);
  },

  // 0011 — identify scopes by id, not name.
  //
  // Until now `scopes.name` was globally UNIQUE and every per-day record was
  // keyed by name (daily_scopes.name, joined back to scopes by name). That made
  // it impossible for two users to author a private scope with the same name,
  // and — if the constraint were merely relaxed — would silently merge two
  // different users' same-named scopes in the feed. This migration moves the
  // join key to scope_id end-to-end and relaxes name uniqueness to per-author,
  // so identical names are allowed but never conflated.
  //
  // Runs with foreign_keys OFF (see migrate()), so rebuilding `scopes` does not
  // cascade-delete subscriptions; ids are preserved so all references hold.
  (d) => {
    // 1) Rebuild `scopes` to drop the inline global UNIQUE(name). Ids and the
    //    created_by attribution are carried over verbatim.
    d.exec(`
      CREATE TABLE scopes_new (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        name       TEXT NOT NULL,
        queries    TEXT NOT NULL,
        interests  TEXT,
        created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      INSERT INTO scopes_new (id, name, queries, interests, created_by, created_at)
        SELECT id, name, queries, interests, created_by, created_at FROM scopes;
      DROP TABLE scopes;
      ALTER TABLE scopes_new RENAME TO scopes;

      -- Names are unique per author. created_by NULL (seeded) maps to bucket 0,
      -- which never collides with a real user id (AUTOINCREMENT starts at 1), so
      -- seeded names stay unique among themselves while each user gets their own
      -- namespace.
      CREATE UNIQUE INDEX idx_scopes_author_name
        ON scopes(COALESCE(created_by, 0), name);
      CREATE INDEX idx_scopes_created_by ON scopes(created_by);
    `);

    // 2) Add daily_scopes.scope_id and backfill from the (still globally unique
    //    at this instant) name. Orphan rows whose name matches no scope keep a
    //    NULL scope_id — unreachable in the feed, exactly as before. ON DELETE
    //    SET NULL preserves archive history when a scope is later removed.
    d.exec(`
      ALTER TABLE daily_scopes
        ADD COLUMN scope_id INTEGER REFERENCES scopes(id) ON DELETE SET NULL;

      UPDATE daily_scopes
        SET scope_id = (SELECT sc.id FROM scopes sc WHERE sc.name = daily_scopes.name)
        WHERE scope_id IS NULL;

      -- Matching is by id now; a scope name is unique per day per scope_id.
      DROP INDEX IF EXISTS idx_daily_scopes_date_name;
      CREATE UNIQUE INDEX idx_daily_scopes_date_scope
        ON daily_scopes(digest_date, scope_id);
      CREATE INDEX idx_daily_scopes_scope ON daily_scopes(scope_id);
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
  if (current >= migrations.length) return current;

  // FK enforcement is toggled around the whole run because some migrations
  // rebuild FK-target tables (e.g. dropping `scopes` to change its uniqueness
  // would otherwise cascade-delete `subscriptions`). The pragma is a no-op
  // inside a transaction, so it must sit outside the per-migration tx; a
  // foreign_key_check inside each tx re-validates before we commit.
  db.pragma('foreign_keys = OFF');
  try {
    for (let version = current; version < migrations.length; version++) {
      const run = migrations[version];
      const tx = db.transaction(() => {
        run(db);
        const violations = db.pragma('foreign_key_check');
        if (violations.length) {
          throw new Error(
            `Migration ${String(version + 1).padStart(4, '0')} produced ` +
              `foreign-key violations: ${JSON.stringify(violations)}`
          );
        }
        // user_version can't be parameterized; version is a controlled integer.
        db.pragma(`user_version = ${version + 1}`);
      });
      tx();
      console.log(`Applied migration ${String(version + 1).padStart(4, '0')}`);
    }
  } finally {
    db.pragma('foreign_keys = ON');
  }

  return db.pragma('user_version', { simple: true });
}
