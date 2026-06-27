import { findByUid } from '../users/queries.js';

/**
 * If the session carries a uid, load the user and attach it as req.user.
 * Leaves req.user undefined for anonymous requests. Self-heals a session
 * whose user no longer exists by clearing the stale uid.
 */
export function attachUser(req, res, next) {
  const uid = req.session?.uid;
  if (!uid) return next();

  const user = findByUid(uid);
  if (user) {
    req.user = user;
  } else {
    delete req.session.uid;
  }
  next();
}

/** Guard for routes that require authentication. */
export function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Not authenticated.' });
  next();
}
