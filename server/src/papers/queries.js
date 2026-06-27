import db from '../db/index.js';

let stmts;
function s() {
  if (!stmts) {
    stmts = {
      byId: db.prepare('SELECT id FROM papers WHERE id = ?'),

      // The latest digest date that has any scope the user follows. Scopes are
      // matched by name (scopes.name = daily_scopes.name), since daily_scopes is
      // the per-day snapshot keyed by name.
      latestDate: db.prepare(`
        SELECT MAX(ds.digest_date) AS d
        FROM daily_scopes ds
        JOIN scopes sc ON sc.name = ds.name
        JOIN subscriptions sub ON sub.scope_id = sc.id
        WHERE sub.user_id = @user_id
      `),

      // Daily feed: curated papers under the user's followed scopes on a given
      // digest date, carrying the scope-relative enrichment and the scope name.
      // Dismissed papers are excluded. A paper appearing under several followed
      // scopes is collapsed to its best (lowest) rank via the GROUP BY + MIN.
      dailyByScope: db.prepare(`
        SELECT p.id, p.external_id, p.title, p.abstract, p.authors, p.url,
               p.pdf_url, p.published_at, p.created_at,
               up.state AS state,
               MIN(spr.rank) AS rank,
               -- enrichment from the row that produced the best rank
               (SELECT sp2.tag FROM scope_papers sp2
                  JOIN daily_scopes d2 ON d2.id = sp2.daily_scope_id
                 WHERE sp2.paper_id = p.id AND d2.digest_date = @date
                 ORDER BY sp2.rank LIMIT 1) AS tag,
               (SELECT sp2.tldr FROM scope_papers sp2
                  JOIN daily_scopes d2 ON d2.id = sp2.daily_scope_id
                 WHERE sp2.paper_id = p.id AND d2.digest_date = @date
                 ORDER BY sp2.rank LIMIT 1) AS tldr,
               (SELECT sp2.zh_summary FROM scope_papers sp2
                  JOIN daily_scopes d2 ON d2.id = sp2.daily_scope_id
                 WHERE sp2.paper_id = p.id AND d2.digest_date = @date
                 ORDER BY sp2.rank LIMIT 1) AS zh_summary,
               (SELECT sp2.code FROM scope_papers sp2
                  JOIN daily_scopes d2 ON d2.id = sp2.daily_scope_id
                 WHERE sp2.paper_id = p.id AND d2.digest_date = @date
                 ORDER BY sp2.rank LIMIT 1) AS code,
               GROUP_CONCAT(DISTINCT ds.name) AS scope_names
        FROM scope_papers spr
        JOIN daily_scopes ds ON ds.id = spr.daily_scope_id
        JOIN scopes sc ON sc.name = ds.name
        JOIN subscriptions sub ON sub.scope_id = sc.id AND sub.user_id = @user_id
        JOIN papers p ON p.id = spr.paper_id
        LEFT JOIN user_papers up ON up.paper_id = p.id AND up.user_id = @user_id
        WHERE ds.digest_date = @date
          AND (up.state IS NULL OR up.state <> 'dismissed')
        GROUP BY p.id
        ORDER BY rank ASC, COALESCE(p.published_at, p.created_at) DESC, p.id DESC
        LIMIT @limit
      `),

      // Saved list: every paper the user explicitly saved, newest save first.
      saved: db.prepare(`
        SELECT p.id, p.external_id, p.title, p.abstract, p.authors, p.url,
               p.pdf_url, p.published_at, p.created_at, up.state AS state
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
    // The original arXiv abstract. Named `summary` to match the generator's
    // archive JSON (paper.summary); the AI reading lives on `zhSummary`.
    summary: row.abstract,
    authors: row.authors,
    url: row.url,
    pdfUrl: row.pdf_url ?? null,
    publishedAt: row.published_at,
    state: row.state ?? null,
    // Enrichment / scope context (present only on the daily feed).
    tag: row.tag ?? null,
    tldr: row.tldr ?? null,
    zhSummary: row.zh_summary ?? null,
    code: row.code ?? null,
    scopes: row.scope_names ? row.scope_names.split(',') : [],
  };
}

export function paperExists(id) {
  return !!s().byId.get(id);
}

/**
 * Daily digest for a user: curated papers under the scopes they follow, from
 * the most recent digest date that has any of those scopes. Empty if the user
 * follows no scopes or none have been collected yet.
 */
export function dailyForUser(userId, limit = 50) {
  const date = s().latestDate.get({ user_id: userId })?.d;
  if (!date) return { date: null, papers: [] };
  const papers = s()
    .dailyByScope.all({ user_id: userId, date, limit })
    .map(toPublic);
  return { date, papers };
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
