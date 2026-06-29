import { Router } from 'express';
import { hashPassword, verifyPassword } from './password.js';
import {
  createUser,
  findByEmail,
  toPublic,
  updatePassword,
} from '../users/queries.js';
import {
  createPasswordResetToken,
  peekPasswordResetToken,
  consumePasswordResetToken,
} from '../users/password-reset-tokens.js';
import { sendMail, emailConfigured } from '../mail/mailer.js';
import {
  loginLimiter,
  signupLimiter,
  checkEmailLimiter,
  forgotPasswordLimiter,
  resetPasswordLimiter,
} from './rate-limit.js';

const router = Router();

// Basic RFC-ish email check — good enough for signup gating.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MIN_PASSWORD = 8;

// Absolute base URL of the app, used to build the reset link mailed to the
// user. APP_BASE_URL wins when set (correct behind a proxy / in prod);
// otherwise fall back to the request's own scheme + host.
function appBaseUrl(req) {
  const env = process.env.APP_BASE_URL;
  const base = env && env.trim() ? env.trim() : `${req.protocol}://${req.get('host')}`;
  return base.replace(/\/+$/, '');
}

/** Attach the authenticated user to the session. */
function login(req, user) {
  return new Promise((resolve, reject) => {
    req.session.regenerate((err) => {
      if (err) return reject(err);

      req.session.uid = user.uid;
      req.session.sessionVersion = user.session_version;

      req.session.save((saveErr) => {
        if (saveErr) return reject(saveErr);
        resolve();
      });
    });
  });
}

/** POST /api/auth/signup — email + password + optional name. */
router.post('/signup', signupLimiter, async (req, res) => {
  const email = String(req.body?.email ?? '').trim().toLowerCase();
  const password = String(req.body?.password ?? '');
  const name = req.body?.name ? String(req.body.name).trim() : null;

  if (!EMAIL_RE.test(email)) {
    return res.status(400).json({ error: 'A valid email is required.' });
  }
  if (password.length < MIN_PASSWORD) {
    return res
      .status(400)
      .json({ error: `Password must be at least ${MIN_PASSWORD} characters.` });
  }

  if (findByEmail(email)) {
    return res.status(409).json({ error: 'That email is already registered.' });
  }

  const passwordHash = await hashPassword(password);
  const user = createUser({ email, passwordHash, name });

  try {
    await login(req, user);
  } catch (err) {
    return res.status(500).json({ error: 'Could not log in.' });
  }
  res.status(201).json({ user: toPublic(user) });
});

/** POST /api/auth/login — email + password. */
router.post('/login', loginLimiter, async (req, res) => {
  const email = String(req.body?.email ?? '').trim().toLowerCase();
  const password = String(req.body?.password ?? '');

  const user = findByEmail(email);
  // Verify even when the user is missing, to avoid leaking which emails exist.
  const ok = user
    ? await verifyPassword(password, user.password_hash)
    : await verifyPassword(password, 'scrypt$00$00');

  if (!user || !ok) {
    return res.status(401).json({ error: 'Invalid email or password.' });
  }

  try {
    await login(req, user);
  } catch (err) {
    return res.status(500).json({ error: 'Could not log in.' });
  }
  res.json({ user: toPublic(user) });
});

/**
 * POST /api/auth/check-email — does this email already have an account?
 * Lets the login page decide whether to prompt for login or for signup.
 *
 * NOTE: this deliberately reveals whether an email is registered. The signup
 * route already leaks the same fact via its 409, so this is not a new exposure
 * — but it makes probing easier, hence checkEmailLimiter throttles it. If
 * enumeration ever becomes a real concern, replace this with an email-link
 * verification flow instead of a synchronous existence check.
 */
router.post('/check-email', checkEmailLimiter, (req, res) => {
  const email = String(req.body?.email ?? '').trim().toLowerCase();
  if (!EMAIL_RE.test(email)) {
    return res.status(400).json({ error: 'A valid email is required.' });
  }
  res.json({ registered: !!findByEmail(email) });
});

/**
 * POST /api/auth/forgot-password — start a password reset.
 * Mails a one-time reset link to the address if an account exists. Always
 * responds 200 with the same body whether or not the email is registered, so
 * this endpoint doesn't become an account-enumeration oracle. Rate-limited per
 * IP to blunt email-bombing.
 */
router.post('/forgot-password', forgotPasswordLimiter, async (req, res) => {
  const email = String(req.body?.email ?? '').trim().toLowerCase();
  if (!EMAIL_RE.test(email)) {
    return res.status(400).json({ error: 'A valid email is required.' });
  }

  const user = findByEmail(email);
  // Only actually mail when the account exists AND mail is configured, but the
  // response is identical either way — never reveal which case occurred.
  if (user && emailConfigured()) {
    const token = createPasswordResetToken(user.id);
    const link = `${appBaseUrl(req)}/reset-password?token=${token}`;
    await sendMail({
      to: user.email,
      subject: '重置你的 PaperDaily 密码 / Reset your PaperDaily password',
      text: [
        '你正在重置 PaperDaily 账户的密码。 / You are resetting your PaperDaily account password.',
        '',
        '点击下面的链接设置新密码（30 分钟内有效）： / Click the link below to set a new password (valid for 30 minutes):',
        link,
        '',
        '如果这不是你本人操作，忽略此邮件即可，密码不会改变。 / If this was not you, ignore this email and your password will remain unchanged.',
      ].join('\n'),
      html: `
        <p>你正在重置 PaperDaily 账户的密码。 / You are resetting your PaperDaily account password.</p>
        <p><a href="${link}">点击此处设置新密码 / Click here to set a new password </a>（30 分钟内有效 / valid for 30 minutes）。 </p>
        <p>如果这不是你本人操作，忽略此邮件即可，密码不会改变。 / If this was not you, ignore this email and your password will remain unchanged.</p>
      `,
    });
  }

  res.json({ status: 'sent' });
});

/**
 * GET /api/auth/reset-password/validate?token=… — is this reset token usable?
 * Lets the reset page show the new-password form only for a live token, and a
 * clear "expired link" message otherwise. Does NOT consume the token.
 */
router.get('/reset-password/validate', (req, res) => {
  const valid = !!peekPasswordResetToken(req.query.token);
  res.json({ valid });
});

/**
 * POST /api/auth/reset-password — set a new password using a reset token.
 * Body: { token, password }. Consumes the token on success so it can't be
 * replayed. Does not log the user in; they return to the login page.
 */
router.post('/reset-password', resetPasswordLimiter, async (req, res) => {
  const token = String(req.body?.token ?? '');
  const password = String(req.body?.password ?? '');

  if (password.length < MIN_PASSWORD) {
    return res
      .status(400)
      .json({ error: `Password must be at least ${MIN_PASSWORD} characters.` });
  }

  // Validate first, then hash, then consume — so a slow hash can't be used to
  // probe token validity, and the token is only spent once we're committing.
  if (!peekPasswordResetToken(token)) {
    return res
      .status(400)
      .json({ error: 'This reset link is invalid or has expired.' });
  }

  const passwordHash = await hashPassword(password);
  const userId = consumePasswordResetToken(token);
  if (!userId) {
    // Raced with another use/expiry between peek and consume.
    return res
      .status(400)
      .json({ error: 'This reset link is invalid or has expired.' });
  }

  updatePassword(userId, passwordHash);
  res.json({ status: 'reset' });
});

/** POST /api/auth/logout — destroy the session. */
router.post('/logout', (req, res) => {
  req.session.destroy((err) => {
    if (err) return res.status(500).json({ error: 'Could not log out.' });
    res.clearCookie('paperdaily.sid');
    res.status(204).end();
  });
});

/** GET /api/auth/me — current user, or 401 if not logged in. */
router.get('/me', (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Not authenticated.' });
  res.json({ user: toPublic(req.user) });
});

export default router;
