import { Router } from 'express';
import { requireAuth } from '../auth/middleware.js';
import { writeLimiter } from '../auth/rate-limit.js';
import {
  listSubscriptions,
  addSubscription,
  removeSubscription,
  countSubscriptions,
} from './queries.js';

const router = Router();

const MAX_KEYWORD_LEN = 80;
const MAX_SUBSCRIPTIONS = 50; // per user — keeps the digest query bounded

// Normalize a keyword: trim, collapse internal whitespace, lowercase. Lowercase
// because the digest match is case-insensitive and the unique index dedupes on
// the stored form.
function normalizeKeyword(raw) {
  return String(raw ?? '')
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

// All subscription routes require a logged-in user.
router.use(requireAuth);

/** GET /api/subscriptions — the user's followed keywords. */
router.get('/', (req, res) => {
  res.json({ subscriptions: listSubscriptions(req.user.id) });
});

/** POST /api/subscriptions — add a keyword. Body: { keyword }. */
router.post('/', writeLimiter, (req, res) => {
  const keyword = normalizeKeyword(req.body?.keyword);

  if (!keyword) {
    return res.status(400).json({ error: 'A keyword is required.' });
  }
  if (keyword.length > MAX_KEYWORD_LEN) {
    return res
      .status(400)
      .json({ error: `Keyword must be at most ${MAX_KEYWORD_LEN} characters.` });
  }
  if (countSubscriptions(req.user.id) >= MAX_SUBSCRIPTIONS) {
    return res
      .status(409)
      .json({ error: `You can follow at most ${MAX_SUBSCRIPTIONS} keywords.` });
  }

  const created = addSubscription(req.user.id, keyword);
  if (!created) {
    return res.status(409).json({ error: 'You already follow that keyword.' });
  }
  res.status(201).json({ subscription: created });
});

/** DELETE /api/subscriptions/:id — remove a keyword the user owns. */
router.delete('/:id', writeLimiter, (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) {
    return res.status(400).json({ error: 'Invalid subscription id.' });
  }

  const removed = removeSubscription(req.user.id, id);
  if (!removed) {
    return res.status(404).json({ error: 'Subscription not found.' });
  }
  res.status(204).end();
});

export default router;
