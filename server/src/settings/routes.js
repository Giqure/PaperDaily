import { Router } from 'express';
import { requireAuth } from '../auth/middleware.js';
import { writeLimiter } from '../auth/rate-limit.js';
import { updatePushSettings, toPushSettings } from '../users/queries.js';

const router = Router();

// A Bark device key is a short URL-safe token. Keep validation lenient but
// bounded so we don't store arbitrary long strings.
const MAX_BARK_KEY_LEN = 120;
const BARK_KEY_RE = /^[A-Za-z0-9_-]+$/;

router.use(requireAuth);

/** GET /api/settings/push — the current user's push settings. */
router.get('/push', (req, res) => {
  res.json({ settings: toPushSettings(req.user) });
});

/**
 * PUT /api/settings/push — update push settings.
 * Body: { emailPushEnabled?, barkPushEnabled?, barkKey? }.
 * Enabling Bark requires a valid key.
 */
router.put('/push', writeLimiter, (req, res) => {
  const emailPushEnabled = !!req.body?.emailPushEnabled;
  const barkPushEnabled = !!req.body?.barkPushEnabled;
  const barkKey = String(req.body?.barkKey ?? '').trim();

  if (barkKey) {
    if (barkKey.length > MAX_BARK_KEY_LEN) {
      return res.status(400).json({ error: `Bark key must be at most ${MAX_BARK_KEY_LEN} characters.` });
    }
    if (!BARK_KEY_RE.test(barkKey)) {
      return res.status(400).json({ error: 'Bark key may only contain letters, digits, "-" and "_".' });
    }
  }
  if (barkPushEnabled && !barkKey) {
    return res.status(400).json({ error: 'A Bark key is required to enable Bark push.' });
  }

  const updated = updatePushSettings(req.user.id, { emailPushEnabled, barkPushEnabled, barkKey });
  res.json({ settings: toPushSettings(updated) });
});

export default router;
