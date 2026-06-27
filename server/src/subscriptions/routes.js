import { Router } from 'express';
import { requireAuth } from '../auth/middleware.js';
import { writeLimiter } from '../auth/rate-limit.js';
import {
  listSubscriptions,
  subscribe,
  unsubscribe,
  countSubscriptions,
  countAuthoredKeywords,
  isLibraryKeyword,
  listLibrary,
} from './queries.js';

const router = Router();

const MAX_KEYWORD_LEN = 80;
const MAX_SUBSCRIPTIONS = 50; // per user — keeps the digest query bounded
const MAX_AUTHORED_KEYWORDS = 3; // per user — keywords introduced to the shared library

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

/** GET /api/subscriptions/library — the shared keyword library to pick from. */
router.get('/library', (req, res) => {
  res.json({ library: listLibrary() });
});

/** GET /api/subscriptions — the user's followed keywords + their contribution budget. */
router.get('/', (req, res) => {
  res.json({
    subscriptions: listSubscriptions(req.user.id),
    authored: {
      used: countAuthoredKeywords(req.user.id),
      max: MAX_AUTHORED_KEYWORDS,
    },
  });
});

/**
 * POST /api/subscriptions — follow a keyword. Body: { keyword }.
 *
 * If the keyword isn't in the shared library, following it contributes it to
 * the library (attributed to this user) so others can subscribe too. Each user
 * may have at most MAX_AUTHORED_KEYWORDS such contributions live at once.
 */
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

  // Contributing a brand-new keyword to the shared library is capped; following
  // a keyword that already exists in the library is not.
  const alreadyInLibrary = isLibraryKeyword(keyword);
  if (!alreadyInLibrary && countAuthoredKeywords(req.user.id) >= MAX_AUTHORED_KEYWORDS) {
    return res.status(409).json({
      error: `You can introduce at most ${MAX_AUTHORED_KEYWORDS} new keywords to the library. Subscribe to existing ones, or remove a keyword you created first.`,
    });
  }

  const result = subscribe(req.user.id, keyword);
  if (result.duplicate) {
    return res.status(409).json({ error: 'You already follow that keyword.' });
  }
  res.status(201).json({ subscription: result.subscription });
});

/**
 * DELETE /api/subscriptions/:id — unfollow a keyword the user owns. If the user
 * was the last subscriber to a keyword they contributed, it's removed from the
 * shared library, freeing their contribution slot.
 */
router.delete('/:id', writeLimiter, (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) {
    return res.status(400).json({ error: 'Invalid subscription id.' });
  }

  const removed = unsubscribe(req.user.id, id);
  if (!removed) {
    return res.status(404).json({ error: 'Subscription not found.' });
  }
  res.status(204).end();
});

export default router;
