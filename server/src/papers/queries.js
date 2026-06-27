import db from '../db/index.js';

let stmts;
function s() {
  if (!stmts) {
    stmts = {
      byId: db.prepare('SELECT id FROM papers WHERE id = ?'),

      // Daily feed: papers matching the user's keywords (FTS), excluding any
      // the user has dismissed. `state` is carried through so the client can
      // mark already-saved items. Newest first.
      daily: db.prepare(`
        SELECT p.id, p.external_id, p.title, p.abstract, p.authors, p.url,
               p.published_at, p.created_at, up.state AS state
        FROM papers_fts f
        JOIN papers p ON p.id = f.rowid
        LEFT JOIN user_papers up ON up.paper_id = p.id AND up.user_id = @user_id
        WHERE f.papers_fts MATCH @q
          AND (up.state IS NULL OR up.state <> 'dismissed')
        ORDER BY COALESCE(p.published_at, p.created_at) DESC, p.id DESC
        LIMIT @limit
      `),

      // Saved list: every paper the user explicitly saved, newest save first.
      saved: db.prepare(`
        SELECT p.id, p.external_id, p.title, p.abstract, p.authors, p.url,
               p.published_at, p.created_at, up.state AS state
        FROM user_papers up
        JOIN papers p ON p.id = up.paper_id
        WHERE up.user_id = @user_id AND up.state = 'saved'
        ORDER BY up.updated_at DESC, up.id DESC
        LIMIT @limit
      `),

      upsertState: db.prepare(`
        INSERT INTO user_papers (user_id, paper_id, state)
        VALUES (@user_id, @paper_id, @state)
        ON CONFLICT(user_id, paper_id)
        DO UPDATE SET state = @state, updated_at = datetime('now')
      `),

      clearState: db.prepare(
        'DELETE FROM user_papers WHERE user_id = @user_id AND paper_id = @paper_id'
      ),
    };
  }
  return stmts;
}

function toPublic(row) {
  if (!row) return null;
  return {
    id: row.id,
    externalId: row.external_id,
    title: row.title,
    abstract: row.abstract,
    authors: row.authors,
    url: row.url,
    publishedAt: row.published_at,
    state: row.state ?? null,
  };
}

/**
 * Build an FTS5 MATCH expression from raw keywords. Each keyword is wrapped in
 * double quotes as a phrase, so user input can't inject FTS operators (AND/OR/
 * NEAR/column filters/parentheses) — a literal `"` inside is escaped by
 * doubling, per FTS5 string syntax. Keywords are OR'd together.
 */
export function buildMatchQuery(keywords) {
  const phrases = keywords
    .map((k) => k.trim())
    .filter(Boolean)
    .map((k) => `"${k.replace(/"/g, '""')}"`);
  return phrases.join(' OR ');
}

export function paperExists(id) {
  return !!s().byId.get(id);
}

/** Daily digest for a user given their keywords. Empty keywords → empty feed. */
export function dailyForKeywords(userId, keywords, limit = 50) {
  const q = buildMatchQuery(keywords);
  if (!q) return [];
  return s().daily.all({ user_id: userId, q, limit }).map(toPublic);
}

export function listSaved(userId, limit = 100) {
  return s().saved.all({ user_id: userId, limit }).map(toPublic);
}

export function setPaperState(userId, paperId, state) {
  s().upsertState.run({ user_id: userId, paper_id: paperId, state });
}

export function clearPaperState(userId, paperId) {
  s().clearState.run({ user_id: userId, paper_id: paperId });
}
