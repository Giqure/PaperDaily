import { Router } from 'express';
import { hashPassword, verifyPassword } from './password.js';
import { createUser, findByEmail, toPublic } from '../users/queries.js';
import { loginLimiter, signupLimiter } from './rate-limit.js';

const router = Router();

// Basic RFC-ish email check — good enough for signup gating.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MIN_PASSWORD = 8;

/** Attach the authenticated user to the session. */
function login(req, user) {
  return new Promise((resolve, reject) => {
    req.session.regenerate((err) => {
      if (err) return reject(err);

      req.session.uid = user.uid;

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
