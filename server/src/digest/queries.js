import db from '../db/index.js';

// Lazy + memoized: prepared statements must be built after migrations run.
let stmts;
function s() {
  if (!stmts) {
    stmts = {
      paperByExternalId: db.prepare(
        'SELECT id FROM papers WHERE external_id = ?'
      ),
      insertPaper: db.prepare(`
        INSERT INTO papers
          (external_id, title, abstract, authors, url, pdf_url, github, published_at)
        VALUES
          (@external_id, @title, @abstract, @authors, @url, @pdf_url, @github, @published_at)
      `),
      // Refresh intrinsic fields if we re-import a paper we've already seen.
      updatePaper: db.prepare(`
        UPDATE papers SET
          title = @title, abstract = @abstract, authors = @authors,
          url = @url, pdf_url = @pdf_url, github = @github,
          published_at = @published_at
        WHERE id = @id
      `),

      dailyScopeByDateName: db.prepare(
        'SELECT id FROM daily_scopes WHERE digest_date = ? AND name = ?'
      ),
      dailyScopeByDateScope: db.prepare(
        'SELECT id FROM daily_scopes WHERE digest_date = ? AND scope_id = ?'
      ),
      // Resolve a catalog scope id from its name. Names are unique per author,
      // so this can match more than one row across authors; the reporter always
      // passes scope.id directly, and this lookup is only a fallback for archive
      // JSON imports that predate scope ids — there the oldest match is the
      // seeded/canonical scope, so order by id.
      scopeIdByName: db.prepare(
        'SELECT id FROM scopes WHERE name = ? ORDER BY id LIMIT 1'
      ),
      insertDailyScope: db.prepare(`
        INSERT INTO daily_scopes
          (digest_date, scope_id, name, queries, interests, top_n, push_n, max_candidates,
           query_delay_seconds, same_day_only, lookback_days, dedup_days)
        VALUES
          (@digest_date, @scope_id, @name, @queries, @interests, @top_n, @push_n, @max_candidates,
           @query_delay_seconds, @same_day_only, @lookback_days, @dedup_days)
      `),
      // Re-importing the same day replaces the membership cleanly.
      deleteScopePapers: db.prepare(
        'DELETE FROM scope_papers WHERE daily_scope_id = ?'
      ),
      // Highest rank already linked under a daily scope, so an append run can
      // continue numbering after the papers stored earlier today. NULL (-> no
      // rows yet) is handled by the caller.
      maxRankForScope: db.prepare(
        'SELECT MAX(rank) AS maxRank FROM scope_papers WHERE daily_scope_id = ?'
      ),
      insertScopePaper: db.prepare(`
        INSERT INTO scope_papers
          (daily_scope_id, paper_id, rank, tag, tldr, position, zh_summary, highlights, code)
        VALUES
          (@daily_scope_id, @paper_id, @rank, @tag, @tldr, @position, @zh_summary, @highlights, @code)
      `),
      // Append-mode variant: a paper already linked to this daily scope (unique
      // on daily_scope_id+paper_id) is silently skipped instead of erroring.
      insertScopePaperIgnore: db.prepare(`
        INSERT OR IGNORE INTO scope_papers
          (daily_scope_id, paper_id, rank, tag, tldr, position, zh_summary, highlights, code)
        VALUES
          (@daily_scope_id, @paper_id, @rank, @tag, @tldr, @position, @zh_summary, @highlights, @code)
      `),

      // Does a digest already exist for this date? Used to decide whether a run
      // creates the day fresh or appends new papers to it.
      dayHasDigest: db.prepare(
        'SELECT 1 FROM daily_scopes WHERE digest_date = ? LIMIT 1'
      ),

      // External ids of papers already stored under any daily scope on/after a
      // cutoff date — used by the reporter to avoid re-surfacing recent papers.
      recentExternalIds: db.prepare(`
        SELECT DISTINCT p.external_id AS id
        FROM scope_papers sp
        JOIN daily_scopes ds ON ds.id = sp.daily_scope_id
        JOIN papers p ON p.id = sp.paper_id
        WHERE ds.digest_date >= @cutoff AND p.external_id IS NOT NULL
      `),
    };
  }
  return stmts;
}

/**
 * Insert or update a paper by its external (arXiv) id. Returns the internal id.
 * Intrinsic fields are refreshed on re-import so corrections in the source flow
 * through, but the dedup key (external_id) keeps a single row per paper.
 */
export function upsertPaper(paper) {
  const row = {
    external_id: paper.external_id,
    title: paper.title,
    abstract: paper.abstract ?? null,
    authors: paper.authors ?? null,
    url: paper.url ?? null,
    pdf_url: paper.pdf_url ?? null,
    github: paper.github || null,
    published_at: paper.published_at ?? null,
  };
  const existing = s().paperByExternalId.get(row.external_id);
  if (existing) {
    s().updatePaper.run({ ...row, id: existing.id });
    return existing.id;
  }
  return s().insertPaper.run(row).lastInsertRowid;
}

/**
 * Insert or replace a (date, scope) record and return its id. If the scope
 * already exists for that day we reuse the row and clear its membership so the
 * caller can re-link papers idempotently.
 *
 * Records are keyed by scope_id. The reporter passes scope.id directly; archive
 * JSON imports (which predate scope ids) fall back to resolving the id from the
 * scope name. A name that matches no catalog scope leaves scope_id NULL — the
 * row is archived but unreachable in the feed, and dedup falls back to name.
 */
export function upsertDailyScope(digestDate, scope, append = false) {
  const scopeId =
    scope.id != null ? scope.id : s().scopeIdByName.get(scope.name)?.id ?? null;
  const row = {
    digest_date: digestDate,
    scope_id: scopeId,
    name: scope.name,
    queries: scope.queries ? JSON.stringify(scope.queries) : null,
    interests: scope.interests ?? null,
    top_n: scope.top_n ?? null,
    push_n: scope.push_n ?? null,
    max_candidates: scope.max_candidates ?? null,
    query_delay_seconds: scope.query_delay_seconds ?? null,
    same_day_only: scope.same_day_only == null ? null : scope.same_day_only ? 1 : 0,
    lookback_days: scope.lookback_days ?? null,
    dedup_days: scope.dedup_days ?? null,
  };
  // Prefer the id-keyed lookup; fall back to name only when the scope is
  // unresolved (legacy archive row with no matching catalog scope).
  const existing =
    scopeId != null
      ? s().dailyScopeByDateScope.get(digestDate, scopeId)
      : s().dailyScopeByDateName.get(digestDate, scope.name);
  if (existing) {
    // Replace mode (default) clears the scope's membership so the caller
    // re-links from scratch. Append mode keeps existing papers — a later run
    // the same day adds only what's new (see importArchiveDay's append option).
    if (!append) s().deleteScopePapers.run(existing.id);
    return existing.id;
  }
  return s().insertDailyScope.run(row).lastInsertRowid;
}

/**
 * Link a paper into a daily scope with its scope-relative enrichment. In append
 * mode a paper already linked to the scope is skipped (INSERT OR IGNORE); the
 * return value reports whether a new row was actually inserted.
 */
export function addScopePaper(dailyScopeId, paperId, rank, enrichment, append = false) {
  const stmt = append ? s().insertScopePaperIgnore : s().insertScopePaper;
  const res = stmt.run({
    daily_scope_id: dailyScopeId,
    paper_id: paperId,
    rank,
    tag: enrichment.tag ?? null,
    tldr: enrichment.tldr ?? null,
    position: enrichment.position ?? null,
    zh_summary: enrichment.zh_summary ?? null,
    highlights: enrichment.highlights ? JSON.stringify(enrichment.highlights) : null,
    code: enrichment.code ?? null,
  });
  return res.changes > 0;
}

/** True when a digest already exists for `date` ('YYYY-MM-DD'). */
export function dayHasDigest(date) {
  return !!s().dayHasDigest.get(date);
}

/** Highest rank linked under a daily scope, or -1 when it has no papers yet. */
export function maxRankForDailyScope(dailyScopeId) {
  const row = s().maxRankForScope.get(dailyScopeId);
  return row?.maxRank == null ? -1 : row.maxRank;
}

/**
 * External (arXiv) ids of papers already stored under any daily scope on or
 * after `cutoffDate` ('YYYY-MM-DD'). The reporter uses this to skip papers it
 * surfaced in the last few days. Returns a Set for O(1) membership checks.
 */
export function recentArchivedExternalIds(cutoffDate) {
  const rows = s().recentExternalIds.all({ cutoff: cutoffDate });
  return new Set(rows.map((r) => r.id));
}

/**
 * Import one archive day (the parsed JSON object: { date, scopes: [...] }).
 * Wrapped in a single transaction so a day imports all-or-nothing.
 *
 * `append` (default false) controls what happens when the day already has a
 * digest. In replace mode each scope's membership is cleared and rebuilt — the
 * behavior manual archive re-imports rely on. In append mode existing papers are
 * kept, new ranks continue after the highest already stored, and a paper already
 * linked to the scope is skipped; `links` then counts only the rows newly added.
 *
 * Returns { date, scopes, papers, links } counts.
 */
export const importArchiveDay = db.transaction((day, { append = false } = {}) => {
  let scopeCount = 0;
  let paperCount = 0;
  let linkCount = 0;
  const seenPapers = new Set();

  for (const entry of day.scopes ?? []) {
    const dailyScopeId = upsertDailyScope(day.date, entry.scope, append);
    scopeCount++;

    // Append mode continues numbering after the papers already stored today;
    // replace mode starts fresh from 0. The counter advances only on a real
    // insert, so skipped duplicates (append mode) don't leave rank gaps.
    let rank = append ? maxRankForDailyScope(dailyScopeId) + 1 : 0;

    const items = entry.items ?? [];
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const p = item.paper;
      const paperId = upsertPaper({
        external_id: p.id,
        title: p.title,
        abstract: p.summary,
        authors: Array.isArray(p.authors) ? p.authors.join(', ') : p.authors,
        url: p.abs_url,
        pdf_url: p.pdf_url,
        github: p.github,
        published_at: p.published,
      });
      const inserted = addScopePaper(dailyScopeId, paperId, rank, item, append);
      if (!inserted) continue; // append mode: paper was already linked today
      rank++;
      if (!seenPapers.has(paperId)) {
        seenPapers.add(paperId);
        paperCount++;
      }
      linkCount++;
    }
  }

  return { date: day.date, scopes: scopeCount, papers: paperCount, links: linkCount };
});
