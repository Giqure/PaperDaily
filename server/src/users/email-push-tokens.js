import { randomBytes } from 'node:crypto';
import db from '../db/index.js';

// Single-use, time-limited tokens that confirm a user controls their account
// email before we start sending digests there. Created when the user clicks
// "Turn on" for email push; consumed when they visit the mailed link.

const TOKEN_TTL_MINUTES = 30;

let stmts;
function s() {
  if (!stmts) {
    stmts = {
      insert: db.prepare(`
        INSERT INTO email_push_tokens (token, user_id, expires_at)
        VALUES (@token, @user_id, @expires_at)
      `),
      byToken: db.prepare('SELECT * FROM email_push_tokens WHERE token = ?'),
      markUsed: db.prepare(
        "UPDATE email_push_tokens SET used_at = datetime('now') WHERE id = ?"
      ),
      // Invalidate any outstanding tokens for a user — issuing a fresh link or
      // turning push off should retire older pending links.
      consumeAllForUser: db.prepare(
        "UPDATE email_push_tokens SET used_at = datetime('now') WHERE user_id = ? AND used_at IS NULL"
      ),
      // Prune dead rows: anything already used or past its expiry is inert and
      // only takes up space. expires_at and datetime('now') are both UTC
      // 'YYYY-MM-DD HH:MM:SS', so a lexical comparison is also chronological.
      pruneDead: db.prepare(
        "DELETE FROM email_push_tokens WHERE used_at IS NOT NULL OR expires_at < datetime('now')"
      ),
    };
  }
  return stmts;
}

/**
 * Delete tokens that can no longer be used (already consumed or expired). Cheap
 * housekeeping so the table doesn't grow without bound; safe to call anytime.
 */
export function pruneEmailPushTokens() {
  return s().pruneDead.run().changes;
}

/**
 * Mint a fresh confirmation token for a user, retiring any still-pending ones
 * so only the most recent link works. Returns the opaque token string.
 */
export function createEmailPushToken(userId) {
  // Opportunistic housekeeping: clear dead rows so the table stays small
  // without a separate scheduled job.
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
 * Validate and consume a confirmation token. Returns the owning user id on
 * success, or null if the token is unknown, already used, or expired. A valid
 * token is marked used so it can't be replayed.
 */
export function consumeEmailPushToken(token) {
  const row = s().byToken.get(String(token ?? ''));
  if (!row || row.used_at) return null;
  // expires_at is stored as a UTC 'YYYY-MM-DD HH:MM:SS' string.
  if (Date.parse(row.expires_at + 'Z') < Date.now()) return null;
  s().markUsed.run(row.id);
  return row.user_id;
}
