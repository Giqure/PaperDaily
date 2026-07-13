import { Router } from 'express';
import { requireAuth } from '../auth/middleware.js';
import { reportGenerateLimiter } from '../auth/rate-limit.js';
import { getScope } from '../subscriptions/queries.js';
import {
  createJob,
  getJobRow,
  jobsAhead,
  hasActiveJobForUser,
  toJobPublic,
  resultForScopes,
} from './queries.js';
import { enqueueJob } from './generate.js';
import { shanghaiToday, isValidDate } from './dates.js';

const router = Router();

// Bound the arXiv/OpenAI fan-out per job, and cap the result feed size.
const MAX_SCOPES_PER_JOB = 10;
const RESULT_LIMIT = 500;

router.use(requireAuth);

// A scope is usable when it exists and is visible to this user (seeded, or
// authored by them). Another user's private scope is treated as invalid so its
// existence never leaks.
function scopeVisibleTo(scopeId, userId) {
  const scope = getScope(scopeId);
  return !!scope && (scope.createdBy == null || scope.createdBy === userId);
}

// Parse a value into a list of positive-integer scope ids, or null if malformed.
// Accepts an array (JSON body) or a comma-separated string (query param).
function parseScopeIds(raw) {
  const parts = Array.isArray(raw)
    ? raw
    : typeof raw === 'string'
      ? raw.split(',')
      : null;
  if (!parts || !parts.length) return null;
  const ids = [];
  const seen = new Set();
  for (const part of parts) {
    const n = Number(part);
    if (!Number.isInteger(n) || n < 1) return null;
    if (!seen.has(n)) {
      seen.add(n);
      ids.push(n);
    }
  }
  return ids.length ? ids : null;
}

// Validate a (date, scopeIds) request shared by /generate and /result. Returns
// { date, scopeIds } on success or { error, status } to send back.
function validateRequest(rawDate, rawScopeIds, userId) {
  if (!isValidDate(rawDate)) {
    return { error: 'A valid date (YYYY-MM-DD) is required.', status: 400 };
  }
  if (rawDate > shanghaiToday()) {
    return { error: 'Date cannot be in the future.', status: 400 };
  }
  const scopeIds = parseScopeIds(rawScopeIds);
  if (!scopeIds) {
    return { error: 'One or more scope ids are required.', status: 400 };
  }
  if (scopeIds.length > MAX_SCOPES_PER_JOB) {
    return { error: `At most ${MAX_SCOPES_PER_JOB} scopes per report.`, status: 400 };
  }
  for (const id of scopeIds) {
    if (!scopeVisibleTo(id, userId)) {
      return { error: 'One or more scopes are invalid.', status: 400 };
    }
  }
  return { date: rawDate, scopeIds };
}

/**
 * POST /api/reports/generate — trigger a background report for a date + scopes.
 * Body: { date: 'YYYY-MM-DD', scopeIds: number[] }. Returns 202 { jobId, status }.
 */
router.post('/generate', reportGenerateLimiter, (req, res) => {
  const v = validateRequest(req.body?.date, req.body?.scopeIds, req.user.id);
  if (v.error) return res.status(v.status).json({ error: v.error });

  if (hasActiveJobForUser(req.user.id)) {
    return res
      .status(409)
      .json({ error: 'A report is already running. Wait for it to finish.' });
  }

  const job = createJob(req.user.id, v.date, v.scopeIds);
  enqueueJob(job.id, { scopeIds: v.scopeIds, date: v.date, userId: req.user.id });
  res.status(202).json({ jobId: job.id, status: job.status });
});

/**
 * GET /api/reports/jobs/:id — poll a job's status. Owner-only; a job that isn't
 * the caller's is reported as 404 so ids can't be probed.
 */
router.get('/jobs/:id', (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) {
    return res.status(400).json({ error: 'Invalid job id.' });
  }
  const row = getJobRow(id);
  if (!row || row.user_id !== req.user.id) {
    return res.status(404).json({ error: 'Job not found.' });
  }
  // How many other users' jobs are queued ahead (0 unless still pending).
  const queuePosition = row.status === 'pending' ? jobsAhead(row.id) : 0;
  res.json({ ...toJobPublic(row), queuePosition });
});

/**
 * GET /api/reports/result?date=YYYY-MM-DD&scopeIds=1,2,3 — the curated papers
 * under the given date + scopes, regardless of subscription (the on-demand
 * panel's data source).
 */
router.get('/result', (req, res) => {
  const v = validateRequest(req.query.date, req.query.scopeIds, req.user.id);
  if (v.error) return res.status(v.status).json({ error: v.error });

  const papers = resultForScopes(req.user.id, v.date, v.scopeIds, RESULT_LIMIT);
  res.json({ date: v.date, scopeIds: v.scopeIds, papers });
});

export default router;
