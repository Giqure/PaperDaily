import db from '../db/index.js';

// Lazy + memoized: preparing at import time would run before migrations have
// created the tables.
let stmts;
function s() {
  if (!stmts) {
    stmts = {
      listByUser: db.prepare(
        'SELECT id, keyword, created_at FROM subscriptions WHERE user_id = ? ORDER BY created_at DESC, id DESC'
      ),
      insert: db.prepare(
        'INSERT INTO subscriptions (user_id, keyword) VALUES (@user_id, @keyword)'
      ),
      byId: db.prepare(
        'SELECT id, user_id, keyword, created_at FROM subscriptions WHERE id = ?'
      ),
      deleteOwned: db.prepare(
        'DELETE FROM subscriptions WHERE id = @id AND user_id = @user_id'
      ),
      keywordsByUser: db.prepare(
        'SELECT keyword FROM subscriptions WHERE user_id = ?'
      ),
      countByUser: db.prepare(
        'SELECT COUNT(*) AS n FROM subscriptions WHERE user_id = ?'
      ),
    };
  }
  return stmts;
}

function toPublic(row) {
  if (!row) return null;
  return { id: row.id, keyword: row.keyword, createdAt: row.created_at };
}

export function listSubscriptions(userId) {
  return s().listByUser.all(userId).map(toPublic);
}

export function countSubscriptions(userId) {
  return s().countByUser.get(userId).n;
}

/** Raw keyword strings for a user — used to build the digest query. */
export function keywordsFor(userId) {
  return s().keywordsByUser.all(userId).map((r) => r.keyword);
}

/**
 * Add a keyword for a user. Returns the created row, or null if it already
 * exists (the unique index throws a constraint error we translate to null).
 */
export function addSubscription(userId, keyword) {
  try {
    const info = s().insert.run({ user_id: userId, keyword });
    return toPublic(s().byId.get(info.lastInsertRowid));
  } catch (err) {
    if (err.code === 'SQLITE_CONSTRAINT_UNIQUE') return null;
    throw err;
  }
}

/** Delete a subscription only if it belongs to the user. Returns true if a row was removed. */
export function removeSubscription(userId, id) {
  const info = s().deleteOwned.run({ id, user_id: userId });
  return info.changes > 0;
}
