import { Router } from 'express';
import { requireAuth } from '../auth/middleware.js';
import { writeLimiter } from '../auth/rate-limit.js';
import {
  updateBarkSettings,
  setEmailPushEnabled,
  toPushSettings,
} from '../users/queries.js';
import {
  createEmailPushToken,
  consumeEmailPushToken,
} from '../users/email-push-tokens.js';
import { sendMail, emailConfigured } from '../mail/mailer.js';

const router = Router();

// A Bark device key is a short URL-safe token. Keep validation lenient but
// bounded so we don't store arbitrary long strings.
const MAX_BARK_KEY_LEN = 120;
const BARK_KEY_RE = /^[A-Za-z0-9_-]+$/;

// Absolute base URL of the app, used to build the confirmation link mailed to
// the user. APP_BASE_URL wins when set (correct behind a proxy / in prod);
// otherwise we fall back to the request's own scheme + host.
function appBaseUrl(req) {
  const env = process.env.APP_BASE_URL;
  const base = env && env.trim() ? env.trim() : `${req.protocol}://${req.get('host')}`;
  return base.replace(/\/+$/, '');
}

/**
 * GET /api/settings/push/email/confirm?token=… — the link mailed to the user.
 * Visiting it with a valid, unused, unexpired token enables email push and
 * sends them back to the app. The token itself authorizes the action, so this
 * route is intentionally NOT behind requireAuth — the user may open the link
 * in a browser without an active session. Registered before requireAuth below.
 */
router.get('/push/email/confirm', (req, res) => {
  const base = appBaseUrl(req);
  const userId = consumeEmailPushToken(req.query.token);
  if (!userId) {
    return res.redirect(`${base}/space?emailPush=invalid`);
  }
  setEmailPushEnabled(userId, true);
  res.redirect(`${base}/space?emailPush=confirmed`);
});

// Everything below requires a logged-in user.
router.use(requireAuth);

/** GET /api/settings/push — the current user's push settings. */
router.get('/push', (req, res) => {
  res.json({ settings: toPushSettings(req.user) });
});

/**
 * PUT /api/settings/push — update Bark push settings.
 * Body: { barkPushEnabled?, barkKey? }.
 * Enabling Bark requires a valid key. Email push is NOT changed here — it has
 * its own confirm/disable routes below.
 */
router.put('/push', writeLimiter, (req, res) => {
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

  const updated = updateBarkSettings(req.user.id, { barkPushEnabled, barkKey });
  res.json({ settings: toPushSettings(updated) });
});

/**
 * POST /api/settings/push/email/request — start turning email push ON. Mails a
 * one-time confirmation link to the user's account address; email push only
 * actually turns on once they click it. No-op if already enabled.
 */
router.post('/push/email/request', writeLimiter, async (req, res) => {
  if (req.user.email_push_enabled) {
    return res.json({ status: 'already-on' });
  }
  if (!emailConfigured()) {
    return res
      .status(503)
      .json({ error: 'Email delivery is not configured on the server.' });
  }

  const token = createEmailPushToken(req.user.id);
  const link = `${appBaseUrl(req)}/api/settings/push/email/confirm?token=${token}`;
  const sent = await sendMail({
    to: req.user.email,
    subject: '确认开启 PaperDaily 邮件推送',
    text: [
      '你正在开启 PaperDaily 每日论文日报的邮件推送。',
      '',
      '点击下面的链接确认开启（30 分钟内有效）：',
      link,
      '',
      '如果这不是你本人操作，忽略此邮件即可，推送不会开启。',
    ].join('\n'),
    html: `
      <p>你正在开启 PaperDaily 每日论文日报的邮件推送。</p>
      <p><a href="${link}">点击此处确认开启</a>（30 分钟内有效）。</p>
      <p>如果这不是你本人操作，忽略此邮件即可，推送不会开启。</p>
    `,
  });

  if (!sent) {
    return res.status(502).json({ error: 'Could not send the confirmation email. Try again later.' });
  }
  res.json({ status: 'sent' });
});

/**
 * POST /api/settings/push/email/disable — turn email push OFF immediately.
 * No confirmation needed to stop receiving mail. Idempotent.
 */
router.post('/push/email/disable', writeLimiter, (req, res) => {
  const updated = setEmailPushEnabled(req.user.id, false);
  res.json({ settings: toPushSettings(updated) });
});

export default router;
