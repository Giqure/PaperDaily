import { Router } from 'express';
import { requireAuth } from '../auth/middleware.js';
import { writeLimiter } from '../auth/rate-limit.js';
import {
  listSubscriptions,
  subscribe,
  unsubscribe,
  countSubscriptions,
  countAuthoredScopes,
  createScope,
  listCatalog,
} from './queries.js';

const router = Router();

const MAX_NAME_LEN = 80;
const MAX_QUERY_LEN = 200;
const MAX_QUERIES = 8; // per scope — keeps the morning collection bounded
const MAX_INTERESTS_LEN = 600;
const MAX_SUBSCRIPTIONS = 50; // per user
const MAX_AUTHORED_SCOPES = 3; // per user — scopes introduced to the catalog

// Normalize a scope name: trim and collapse internal whitespace. Case is
// preserved (names are display labels, e.g. "VLA与机器人基础模型") but the unique
// index on scopes.name still dedupes exact matches.
function normalizeName(raw) {
  return String(raw ?? '').trim().replace(/\s+/g, ' ');
}

// Clean a list of arXiv query strings: trim, drop empties, dedupe, cap count.
function normalizeQueries(raw) {
  const list = Array.isArray(raw) ? raw : [raw];
  const out = [];
  for (const q of list) {
    const v = String(q ?? '').trim();
    if (v && !out.includes(v)) out.push(v);
  }
  return out;
}

// All subscription routes require a logged-in user.
router.use(requireAuth);

/** GET /api/subscriptions/catalog — the scopes this user may pick from. */
router.get('/catalog', (req, res) => {
  res.json({ catalog: listCatalog(req.user.id) });
});

/** GET /api/subscriptions — the user's followed scopes + contribution budget. */
router.get('/', (req, res) => {
  res.json({
    subscriptions: listSubscriptions(req.user.id),
    authored: {
      used: countAuthoredScopes(req.user.id),
      max: MAX_AUTHORED_SCOPES,
    },
  });
});

/**
 * POST /api/subscriptions — follow an existing catalog scope.
 * Body: { scopeId }.
 */
router.post('/', writeLimiter, (req, res) => {
  const scopeId = Number(req.body?.scopeId);
  if (!Number.isInteger(scopeId) || scopeId < 1) {
    return res.status(400).json({ error: 'A valid scopeId is required.' });
  }
  if (countSubscriptions(req.user.id) >= MAX_SUBSCRIPTIONS) {
    return res
      .status(409)
      .json({ error: `You can follow at most ${MAX_SUBSCRIPTIONS} scopes.` });
  }

  const result = subscribe(req.user.id, scopeId);
  if (result.missing) {
    return res.status(404).json({ error: 'That scope no longer exists.' });
  }
  if (result.duplicate) {
    return res.status(409).json({ error: 'You already follow that scope.' });
  }
  res.status(201).json({ subscription: result.subscription });
});

/**
 * POST /api/subscriptions/scopes — author a new scope and follow it. The scope
 * is private to its author: only they can see it in their catalog or subscribe
 * to it. Each user may have at most MAX_AUTHORED_SCOPES live.
 * Body: { name, queries: string[], interests }.
 */
router.post('/scopes', writeLimiter, (req, res) => {
  const name = normalizeName(req.body?.name);
  const queries = normalizeQueries(req.body?.queries);
  const interests = String(req.body?.interests ?? '').trim();

  if (!name) {
    return res.status(400).json({ error: 'A scope name is required.' });
  }
  if (name.length > MAX_NAME_LEN) {
    return res
      .status(400)
      .json({ error: `Name must be at most ${MAX_NAME_LEN} characters.` });
  }
  if (!queries.length) {
    return res
      .status(400)
      .json({ error: 'At least one arXiv query is required.' });
  }
  if (queries.length > MAX_QUERIES) {
    return res
      .status(400)
      .json({ error: `A scope may have at most ${MAX_QUERIES} queries.` });
  }
  if (queries.some((q) => q.length > MAX_QUERY_LEN)) {
    return res
      .status(400)
      .json({ error: `Each query must be at most ${MAX_QUERY_LEN} characters.` });
  }
  if (interests.length > MAX_INTERESTS_LEN) {
    return res.status(400).json({
      error: `Interests must be at most ${MAX_INTERESTS_LEN} characters.`,
    });
  }
  if (countSubscriptions(req.user.id) >= MAX_SUBSCRIPTIONS) {
    return res
      .status(409)
      .json({ error: `You can follow at most ${MAX_SUBSCRIPTIONS} scopes.` });
  }
  if (countAuthoredScopes(req.user.id) >= MAX_AUTHORED_SCOPES) {
    return res.status(409).json({
      error: `You can introduce at most ${MAX_AUTHORED_SCOPES} scopes to the catalog. Remove one you created first.`,
    });
  }

  const created = createScope(req.user.id, { name, queries, interests });
  if (created.duplicateName) {
    return res
      .status(409)
      .json({ error: 'A scope with that name already exists. Subscribe to it instead.' });
  }

  // Auto-follow the scope the user just authored.
  const sub = subscribe(req.user.id, created.scope.id);
  res.status(201).json({ subscription: sub.subscription, scope: created.scope });
});

/**
 * DELETE /api/subscriptions/:id — unfollow a scope the user owns. If the user
 * was the last subscriber to a scope they authored, it's removed from the
 * catalog, freeing their contribution slot.
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
