import db from '../db/index.js';

// Lazy + memoized: preparing at import time would run before migrations have
// created the tables.
let stmts;
function s() {
  if (!stmts) {
    stmts = {
      // A subscription joined to its library entry, so we can tell the client
      // whether the keyword is user-contributed ("custom") and whether *this*
      // user is its author.
      listByUser: db.prepare(`
        SELECT sub.id, sub.keyword, sub.created_at,
               lib.created_by AS author_id
        FROM subscriptions sub
        LEFT JOIN keywords_library lib ON lib.keyword = sub.keyword
        WHERE sub.user_id = ?
        ORDER BY sub.created_at DESC, sub.id DESC
      `),
      insertSub: db.prepare(
        'INSERT INTO subscriptions (user_id, keyword) VALUES (@user_id, @keyword)'
      ),
      subById: db.prepare(`
        SELECT sub.id, sub.user_id, sub.keyword, sub.created_at,
               lib.created_by AS author_id
        FROM subscriptions sub
        LEFT JOIN keywords_library lib ON lib.keyword = sub.keyword
        WHERE sub.id = ?
      `),
      subRowById: db.prepare(
        'SELECT id, user_id, keyword FROM subscriptions WHERE id = ?'
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

      // Library
      libraryGet: db.prepare(
        'SELECT id, keyword, created_by FROM keywords_library WHERE keyword = ?'
      ),
      listLibrary: db.prepare(
        'SELECT id, keyword, created_by FROM keywords_library ORDER BY keyword'
      ),
      insertLibrary: db.prepare(
        'INSERT INTO keywords_library (keyword, created_by) VALUES (@keyword, @created_by)'
      ),
      deleteLibrary: db.prepare('DELETE FROM keywords_library WHERE id = ?'),
      countAuthored: db.prepare(
        'SELECT COUNT(*) AS n FROM keywords_library WHERE created_by = ?'
      ),
      subscriberCount: db.prepare(
        'SELECT COUNT(*) AS n FROM subscriptions WHERE keyword = ?'
      ),
    };
  }
  return stmts;
}

function toPublic(row) {
  if (!row) return null;
  // A keyword is "custom" when it has an author (created_by is non-null);
  // seeded library keywords have a null author.
  return {
    id: row.id,
    keyword: row.keyword,
    isCustom: row.author_id != null,
    createdAt: row.created_at,
  };
}

export function listSubscriptions(userId) {
  return s().listByUser.all(userId).map(toPublic);
}

export function countSubscriptions(userId) {
  return s().countByUser.get(userId).n;
}

/** How many library keywords this user has authored (their live contributions). */
export function countAuthoredKeywords(userId) {
  return s().countAuthored.get(userId).n;
}

/** The shared keyword library. `createdBy` is null for seeded keywords. */
export function listLibrary() {
  return s()
    .listLibrary.all()
    .map((r) => ({ id: r.id, keyword: r.keyword, createdBy: r.created_by }));
}

/** Is this (already-normalized) keyword already in the shared library? */
export function isLibraryKeyword(keyword) {
  return !!s().libraryGet.get(keyword);
}

/** Raw keyword strings for a user — used to build the digest query. */
export function keywordsFor(userId) {
  return s().keywordsByUser.all(userId).map((r) => r.keyword);
}

/**
 * Subscribe a user to a keyword.
 *
 * If the keyword isn't in the shared library yet, it's contributed to the
 * library attributed to this user (the caller must have already checked the
 * authored-keyword cap). Both the library insert and the subscription insert
 * happen in one transaction so we never leave a contributed keyword with no
 * subscriber on a mid-way failure.
 *
 * Returns:
 *   { subscription }            on success
 *   { duplicate: true }         if the user already follows this keyword
 */
export const subscribe = db.transaction((userId, keyword) => {
  let lib = s().libraryGet.get(keyword);
  if (!lib) {
    const info = s().insertLibrary.run({ keyword, created_by: userId });
    lib = { id: info.lastInsertRowid, keyword, created_by: userId };
  }

  try {
    const info = s().insertSub.run({ user_id: userId, keyword });
    return { subscription: toPublic(s().subById.get(info.lastInsertRowid)) };
  } catch (err) {
    if (err.code === 'SQLITE_CONSTRAINT_UNIQUE') {
      // Already subscribed. If we just created the library entry for this
      // keyword we'd be rolling back anyway (the transaction throws below),
      // but a duplicate only happens when the keyword already existed, so the
      // library row we found was pre-existing — nothing to clean up.
      return { duplicate: true };
    }
    throw err;
  }
});

/**
 * Remove a user's subscription. If that was the last subscriber to a
 * user-contributed keyword, the keyword is garbage-collected from the shared
 * library (freeing the author's contribution slot). Seeded keywords (no author)
 * are never removed.
 *
 * Returns true if a subscription was removed.
 */
export const unsubscribe = db.transaction((userId, id) => {
  const sub = s().subRowById.get(id);
  if (!sub || sub.user_id !== userId) return false;

  s().deleteOwned.run({ id, user_id: userId });

  const lib = s().libraryGet.get(sub.keyword);
  if (lib && lib.created_by != null) {
    const remaining = s().subscriberCount.get(sub.keyword).n;
    if (remaining === 0) {
      s().deleteLibrary.run(lib.id);
    }
  }
  return true;
});
