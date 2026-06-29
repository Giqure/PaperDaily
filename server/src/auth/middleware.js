import { findByUid } from '../users/queries.js';

/**
 * If the session carries a uid, load the user and attach it as req.user.
 * Leaves req.user undefined for anonymous requests. Self-heals a session
 * whose user no longer exists, or whose version is stale after a password reset,
 * by destroying it.
 */
export function attachUser(req, res, next) {
  const uid = req.session?.uid;
  if (!uid) return next();

  const user = findByUid(uid);
  if (user && req.session.sessionVersion === user.session_version) {
    req.user = user;
  } else if (req.session) {
    req.session.destroy(() => {});
  }
  next();
}

/** Guard for routes that require authentication. */
export function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Not authenticated.' });
  next();
}
