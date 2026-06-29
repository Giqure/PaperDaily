import { Router } from 'express';
import { requireAuth } from '../auth/middleware.js';
import { writeLimiter, aiSuggestLimiter } from '../auth/rate-limit.js';
import {
  listSubscriptions,
  subscribe,
  unsubscribe,
  countSubscriptions,
  countAuthoredScopes,
  createScope,
  listCatalog,
} from './queries.js';
import { suggestScopeFields } from './suggest.js';

const router = Router();

const MAX_NAME_LEN = 80;
const MIN_NAME_LEN = 8; // names below this are too vague to query/curate on
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
  const nameEn = normalizeName(req.body?.nameEn);
  const nameZh = normalizeName(req.body?.nameZh);
  const queries = normalizeQueries(req.body?.queries);
  const interests = String(req.body?.interests ?? '').trim();

  if (!name) {
    return res.status(400).json({ error: 'A scope name is required.' });
  }
  if (name.length < MIN_NAME_LEN) {
    return res
      .status(400)
      .json({ error: `Name must be at least ${MIN_NAME_LEN} characters.` });
  }
  if (name.length > MAX_NAME_LEN) {
    return res
      .status(400)
      .json({ error: `Name must be at most ${MAX_NAME_LEN} characters.` });
  }
  if (nameEn.length > MAX_NAME_LEN || nameZh.length > MAX_NAME_LEN) {
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

  const created = createScope(req.user.id, {
    name,
    nameEn: nameEn || null,
    nameZh: nameZh || name,
    queries,
    interests,
  });
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
 * POST /api/subscriptions/scopes/suggest — AI-assess the draft name, rewrite it
 * into refined bilingual (zh/en) scope names, and propose queries + interests.
 * Best-effort: returns 503 when the AI endpoint isn't configured or the model
 * output can't be used, so the client can fall back to manual entry. The
 * returned values are normalized/clamped to the same limits the create route
 * enforces, so they paste straight into the form. Each refined name falls back
 * to the input when the model didn't return a usable one.
 * Body: { name }.
 */
router.post('/scopes/suggest', aiSuggestLimiter, async (req, res) => {
  const name = normalizeName(req.body?.name);
  if (!name) {
    return res.status(400).json({ error: 'A scope name is required.' });
  }
  if (name.length < MIN_NAME_LEN) {
    return res
      .status(400)
      .json({ error: `Name must be at least ${MIN_NAME_LEN} characters.` });
  }
  if (name.length > MAX_NAME_LEN) {
    return res
      .status(400)
      .json({ error: `Name must be at most ${MAX_NAME_LEN} characters.` });
  }

  let suggestion;
  try {
    suggestion = await suggestScopeFields(name);
  } catch {
    suggestion = null;
  }
  if (!suggestion) {
    return res
      .status(503)
      .json({ error: 'Suggestions are unavailable right now. Fill the fields in manually.' });
  }

  // Clamp to the create-route limits so the result is always valid to submit.
  const queries = normalizeQueries(suggestion.queries)
    .filter((q) => q.length <= MAX_QUERY_LEN)
    .slice(0, MAX_QUERIES);
  const interests = String(suggestion.interests ?? '')
    .trim()
    .slice(0, MAX_INTERESTS_LEN);

  if (!queries.length) {
    return res
      .status(503)
      .json({ error: 'Suggestions are unavailable right now. Fill the fields in manually.' });
  }

  // Keep each refined name within bounds; drop it (empty) if unusable so the
  // client can fall back to what the user typed. The Chinese name doubles as the
  // canonical fallback when the model returned nothing for it.
  const clampName = (n) => {
    const v = normalizeName(n);
    return v.length >= MIN_NAME_LEN && v.length <= MAX_NAME_LEN ? v : '';
  };
  const nameZh = clampName(suggestion.nameZh) || name;
  const nameEn = clampName(suggestion.nameEn);

  res.json({ nameZh, nameEn, queries, interests });
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
