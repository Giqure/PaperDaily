import db from '../db/index.js';

// Lazy + memoized: prepared statements must be built after migrations run.
let stmts;
function s() {
  if (!stmts) {
    stmts = {
      insertJob: db.prepare(`
        INSERT INTO report_jobs (user_id, target_date, scope_ids)
        VALUES (@user_id, @target_date, @scope_ids)
      `),
      jobById: db.prepare('SELECT * FROM report_jobs WHERE id = ?'),
      // A user's own in-flight job, if any — used to reject a concurrent enqueue.
      activeJobForUser: db.prepare(`
        SELECT 1 FROM report_jobs
        WHERE user_id = ? AND status IN ('pending','running') LIMIT 1
      `),
      // How many other jobs are ahead of this one in the (global, FIFO) queue:
      // still-active jobs created earlier. Jobs run one at a time across all
      // users, so this is the count a waiting user is queued behind.
      jobsAhead: db.prepare(`
        SELECT COUNT(*) AS n FROM report_jobs
        WHERE status IN ('pending','running') AND id < ?
      `),
      setRunning: db.prepare(`
        UPDATE report_jobs
        SET status = 'running', started_at = datetime('now'), updated_at = datetime('now')
        WHERE id = @id
      `),
      setDone: db.prepare(`
        UPDATE report_jobs
        SET status = 'done', reused_scope_ids = @reused, generated_scope_ids = @generated,
            finished_at = datetime('now'), updated_at = datetime('now')
        WHERE id = @id
      `),
      setFailed: db.prepare(`
        UPDATE report_jobs
        SET status = 'failed', error = @error,
            finished_at = datetime('now'), updated_at = datetime('now')
        WHERE id = @id
      `),
      // Boot reconciliation: any job still pending/running after a restart was
      // interrupted mid-flight and will never resume, so fail it (else the client
      // polls forever).
      markInterrupted: db.prepare(`
        UPDATE report_jobs
        SET status = 'failed', error = 'interrupted by server restart',
            finished_at = datetime('now'), updated_at = datetime('now')
        WHERE status IN ('pending','running')
      `),

      // Result feed for the on-demand panel: curated papers under the SELECTED
      // scopes on a given date, subscription-independent (unlike the daily/all
      // feeds). Deduped by paper (a paper under several selected scopes collapses
      // to its best rank); enrichment is taken from the best-ranked row that
      // belongs to one of the SELECTED scopes that date, so nothing leaks from an
      // unselected scope. The scope id list is bound as a JSON array and expanded
      // via json_each, keeping this a single memoizable prepared statement.
      resultByScopes: db.prepare(`
        SELECT p.id, p.external_id, p.title, p.abstract, p.authors, p.url,
               p.pdf_url, p.published_at, p.created_at,
               up.state AS state,
               ds.digest_date AS digest_date,
               MIN(spr.rank) AS rank,
               (SELECT sp2.tag FROM scope_papers sp2
                  JOIN daily_scopes d2 ON d2.id = sp2.daily_scope_id
                 WHERE sp2.paper_id = p.id AND d2.digest_date = @date
                   AND d2.scope_id IN (SELECT value FROM json_each(@scope_ids))
                 ORDER BY sp2.rank LIMIT 1) AS tag,
               (SELECT sp2.tldr FROM scope_papers sp2
                  JOIN daily_scopes d2 ON d2.id = sp2.daily_scope_id
                 WHERE sp2.paper_id = p.id AND d2.digest_date = @date
                   AND d2.scope_id IN (SELECT value FROM json_each(@scope_ids))
                 ORDER BY sp2.rank LIMIT 1) AS tldr,
               (SELECT sp2.zh_summary FROM scope_papers sp2
                  JOIN daily_scopes d2 ON d2.id = sp2.daily_scope_id
                 WHERE sp2.paper_id = p.id AND d2.digest_date = @date
                   AND d2.scope_id IN (SELECT value FROM json_each(@scope_ids))
                 ORDER BY sp2.rank LIMIT 1) AS zh_summary,
               (SELECT sp2.code FROM scope_papers sp2
                  JOIN daily_scopes d2 ON d2.id = sp2.daily_scope_id
                 WHERE sp2.paper_id = p.id AND d2.digest_date = @date
                   AND d2.scope_id IN (SELECT value FROM json_each(@scope_ids))
                 ORDER BY sp2.rank LIMIT 1) AS code,
               GROUP_CONCAT(DISTINCT ds.name) AS scope_names
        FROM scope_papers spr
        JOIN daily_scopes ds ON ds.id = spr.daily_scope_id
        JOIN papers p ON p.id = spr.paper_id
        LEFT JOIN user_papers up ON up.paper_id = p.id AND up.user_id = @user_id
        WHERE ds.digest_date = @date
          AND ds.scope_id IN (SELECT value FROM json_each(@scope_ids))
        GROUP BY p.id
        ORDER BY rank ASC, COALESCE(p.published_at, p.created_at) DESC, p.id DESC
        LIMIT @limit
      `),
    };
  }
  return stmts;
}

// Parse a JSON-array column into a JS array, tolerating null/bad data.
function safeJsonArray(raw) {
  if (raw == null) return [];
  try {
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

// The public paper shape the client renders — mirrors papers/queries.js toPublic
// so the on-demand panel can reuse PaperCard exactly like the daily/all feeds.
function toPublic(row) {
  if (!row) return null;
  return {
    id: row.id,
    externalId: row.external_id,
    title: row.title,
    summary: row.abstract,
    authors: row.authors,
    url: row.url,
    pdfUrl: row.pdf_url ?? null,
    publishedAt: row.published_at,
    state: row.state ?? null,
    tag: row.tag ?? null,
    tldr: row.tldr ?? null,
    zhSummary: row.zh_summary ?? null,
    code: row.code ?? null,
    scopes: row.scope_names ? row.scope_names.split(',') : [],
    digestDate: row.digest_date ?? null,
  };
}

// Public job shape: snake_case columns -> camelCase, id-array columns parsed.
export function toJobPublic(row) {
  if (!row) return null;
  return {
    id: row.id,
    status: row.status,
    targetDate: row.target_date,
    scopeIds: safeJsonArray(row.scope_ids),
    reusedScopeIds: safeJsonArray(row.reused_scope_ids),
    generatedScopeIds: safeJsonArray(row.generated_scope_ids),
    error: row.error ?? null,
    createdAt: row.created_at,
    startedAt: row.started_at ?? null,
    finishedAt: row.finished_at ?? null,
  };
}

/** Create a pending job. Returns its public shape. */
export function createJob(userId, targetDate, scopeIds) {
  const info = s().insertJob.run({
    user_id: userId,
    target_date: targetDate,
    scope_ids: JSON.stringify(scopeIds),
  });
  return toJobPublic(s().jobById.get(info.lastInsertRowid));
}

/** Raw job row by id (includes user_id for owner checks), or undefined. */
export function getJobRow(id) {
  return s().jobById.get(id);
}

/**
 * Number of still-active jobs queued ahead of job `id`. Jobs run one at a time
 * across all users (global FIFO), so a `pending` job with N ahead waits for N
 * runs before its own. 0 once the job is itself running or finished.
 */
export function jobsAhead(id) {
  return s().jobsAhead.get(id).n;
}

/** True when the user already has a pending/running job. */
export function hasActiveJobForUser(userId) {
  return !!s().activeJobForUser.get(userId);
}

export function setJobRunning(id) {
  s().setRunning.run({ id });
}

export function setJobDone(id, reusedScopeIds, generatedScopeIds) {
  s().setDone.run({
    id,
    reused: JSON.stringify(reusedScopeIds),
    generated: JSON.stringify(generatedScopeIds),
  });
}

export function setJobFailed(id, error) {
  s().setFailed.run({ id, error: String(error).slice(0, 1000) });
}

/** Fail any job left pending/running after a restart. Call once at boot. */
export function markInterruptedJobs() {
  return s().markInterrupted.run().changes;
}

/**
 * Curated papers under `scopeIds` on `date`, in the public paper shape,
 * regardless of the user's subscriptions. `state` reflects the requesting user.
 */
export function resultForScopes(userId, date, scopeIds, limit = 500) {
  return s()
    .resultByScopes.all({
      user_id: userId,
      date,
      scope_ids: JSON.stringify(scopeIds),
      limit,
    })
    .map(toPublic);
}

