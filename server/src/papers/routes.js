import { Router } from 'express';
import { requireAuth } from '../auth/middleware.js';
import { writeLimiter } from '../auth/rate-limit.js';
import { keywordsFor } from '../subscriptions/queries.js';
import {
  dailyForKeywords,
  listSaved,
  paperExists,
  setPaperState,
  clearPaperState,
} from './queries.js';

const router = Router();

const VALID_STATES = new Set(['saved', 'dismissed']);
const DEFAULT_DAILY_LIMIT = 50;
const MAX_DAILY_LIMIT = 100;

router.use(requireAuth);

/**
 * GET /api/papers/daily — today's digest: papers matching the user's followed
 * keywords, with dismissed ones filtered out. Empty if the user follows no
 * keywords.
 */
router.get('/daily', (req, res) => {
  const keywords = keywordsFor(req.user.id);
  const limit = clampLimit(req.query.limit, DEFAULT_DAILY_LIMIT, MAX_DAILY_LIMIT);
  const papers = dailyForKeywords(req.user.id, keywords, limit);
  res.json({ papers, keywords });
});

/** GET /api/papers/saved — papers the user has saved. */
router.get('/saved', (req, res) => {
  res.json({ papers: listSaved(req.user.id) });
});

/**
 * PUT /api/papers/:id/state — set this user's relationship to a paper.
 * Body: { state: 'saved' | 'dismissed' | null }. null/absent clears the state.
 */
router.put('/:id/state', writeLimiter, (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) {
    return res.status(400).json({ error: 'Invalid paper id.' });
  }

  const state = req.body?.state ?? null;
  if (state !== null && !VALID_STATES.has(state)) {
    return res
      .status(400)
      .json({ error: "state must be 'saved', 'dismissed', or null." });
  }

  if (!paperExists(id)) {
    return res.status(404).json({ error: 'Paper not found.' });
  }

  if (state === null) {
    clearPaperState(req.user.id, id);
  } else {
    setPaperState(req.user.id, id, state);
  }
  res.json({ id, state });
});

// Parse and clamp a limit query param to [1, max], falling back to a default.
function clampLimit(raw, fallback, max) {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) return fallback;
  return Math.min(n, max);
}

export default router;
