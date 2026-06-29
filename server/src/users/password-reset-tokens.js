import { randomBytes } from 'node:crypto';
import db from '../db/index.js';

// Single-use, time-limited tokens that let a user who forgot their password set
// a new one. Created when the user requests a reset; consumed when they submit a
// new password through the mailed link. Mirrors email-push-tokens.js.

const TOKEN_TTL_MINUTES = 30;

let stmts;
function s() {
  if (!stmts) {
    stmts = {
      insert: db.prepare(`
        INSERT INTO password_reset_tokens (token, user_id, expires_at)
        VALUES (@token, @user_id, @expires_at)
      `),
      byToken: db.prepare('SELECT * FROM password_reset_tokens WHERE token = ?'),
      markUsed: db.prepare(
        "UPDATE password_reset_tokens SET used_at = datetime('now') WHERE id = ?"
      ),
      // Issuing a fresh link retires older pending ones for the same user.
      consumeAllForUser: db.prepare(
        "UPDATE password_reset_tokens SET used_at = datetime('now') WHERE user_id = ? AND used_at IS NULL"
      ),
      // Prune inert rows (used or expired). expires_at and datetime('now') are
      // both UTC 'YYYY-MM-DD HH:MM:SS', so a lexical compare is chronological.
      pruneDead: db.prepare(
        "DELETE FROM password_reset_tokens WHERE used_at IS NOT NULL OR expires_at < datetime('now')"
      ),
    };
  }
  return stmts;
}

/**
 * Mint a fresh reset token for a user, retiring any still-pending ones so only
 * the most recent link works. Returns the opaque token string.
 */
export function createPasswordResetToken(userId) {
  // Opportunistic housekeeping so the table stays small without a cron job.
  s().pruneDead.run();
  s().consumeAllForUser.run(userId);
  const token = randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + TOKEN_TTL_MINUTES * 60_000)
    .toISOString()
    .replace('T', ' ')
    .slice(0, 19);
  s().insert.run({ token, user_id: userId, expires_at: expiresAt });
  return token;
}

/**
 * Peek at a reset token without consuming it. Returns the owning user id if the
 * token is valid (known, unused, unexpired), else null. Used to validate the
 * link before showing the new-password form, so an invalid link fails early.
 */
export function peekPasswordResetToken(token) {
  const row = s().byToken.get(String(token ?? ''));
  if (!row || row.used_at) return null;
  if (Date.parse(row.expires_at + 'Z') < Date.now()) return null;
  return row.user_id;
}

/**
 * Validate and consume a reset token. Returns the owning user id on success, or
 * null if unknown, already used, or expired. A valid token is marked used so it
 * can't be replayed.
 */
export function consumePasswordResetToken(token) {
  const row = s().byToken.get(String(token ?? ''));
  if (!row || row.used_at) return null;
  if (Date.parse(row.expires_at + 'Z') < Date.now()) return null;
  s().markUsed.run(row.id);
  return row.user_id;
}
