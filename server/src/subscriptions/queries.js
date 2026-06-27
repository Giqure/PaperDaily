import db from '../db/index.js';

// Lazy + memoized: preparing at import time would run before migrations have
// created the tables.
let stmts;
function s() {
  if (!stmts) {
    stmts = {
      // A user's followed scopes, joined to the catalog so we can tell the
      // client the scope's rule and whether this user authored it.
      listByUser: db.prepare(`
        SELECT sub.id, sub.created_at,
               sc.id AS scope_id, sc.name, sc.queries, sc.interests,
               sc.created_by AS author_id
        FROM subscriptions sub
        JOIN scopes sc ON sc.id = sub.scope_id
        WHERE sub.user_id = ?
        ORDER BY sub.created_at DESC, sub.id DESC
      `),
      insertSub: db.prepare(
        'INSERT INTO subscriptions (user_id, scope_id) VALUES (@user_id, @scope_id)'
      ),
      subById: db.prepare(`
        SELECT sub.id, sub.user_id, sub.created_at,
               sc.id AS scope_id, sc.name, sc.queries, sc.interests,
               sc.created_by AS author_id
        FROM subscriptions sub
        JOIN scopes sc ON sc.id = sub.scope_id
        WHERE sub.id = ?
      `),
      subRowById: db.prepare(
        'SELECT id, user_id, scope_id FROM subscriptions WHERE id = ?'
      ),
      deleteOwned: db.prepare(
        'DELETE FROM subscriptions WHERE id = @id AND user_id = @user_id'
      ),
      countByUser: db.prepare(
        'SELECT COUNT(*) AS n FROM subscriptions WHERE user_id = ?'
      ),
      subscribedScopeIds: db.prepare(
        'SELECT scope_id FROM subscriptions WHERE user_id = ?'
      ),

      // Catalog
      scopeById: db.prepare(
        'SELECT id, name, queries, interests, created_by FROM scopes WHERE id = ?'
      ),
      scopeByName: db.prepare(
        'SELECT id, name, queries, interests, created_by FROM scopes WHERE name = ?'
      ),
      listCatalog: db.prepare(
        'SELECT id, name, queries, interests, created_by FROM scopes ORDER BY name'
      ),
      // Catalog scopes that have at least one subscriber — the set the reporter
      // actually collects, so arXiv load tracks real demand and user-authored
      // scopes are picked up automatically.
      scopesWithSubscribers: db.prepare(`
        SELECT sc.id, sc.name, sc.queries, sc.interests, sc.created_by
        FROM scopes sc
        WHERE EXISTS (SELECT 1 FROM subscriptions sub WHERE sub.scope_id = sc.id)
        ORDER BY sc.name
      `),
      insertScope: db.prepare(
        'INSERT INTO scopes (name, queries, interests, created_by) VALUES (@name, @queries, @interests, @created_by)'
      ),
      deleteScope: db.prepare('DELETE FROM scopes WHERE id = ?'),
      countAuthored: db.prepare(
        'SELECT COUNT(*) AS n FROM scopes WHERE created_by = ?'
      ),
      subscriberCount: db.prepare(
        'SELECT COUNT(*) AS n FROM subscriptions WHERE scope_id = ?'
      ),
    };
  }
  return stmts;
}

// Parse the JSON queries column into an array, tolerating bad/empty data.
function parseQueries(raw) {
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr.map(String) : [];
  } catch {
    return [];
  }
}

function scopeToPublic(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    queries: parseQueries(row.queries),
    interests: row.interests ?? '',
    // A scope is "custom" when it has an author; seeded scopes have none.
    isCustom: row.created_by != null,
    createdBy: row.created_by ?? null,
  };
}

// A subscription row carries both its own id/created_at and the joined scope.
function subToPublic(row) {
  if (!row) return null;
  return {
    id: row.id,
    createdAt: row.created_at,
    scope: scopeToPublic({
      id: row.scope_id,
      name: row.name,
      queries: row.queries,
      interests: row.interests,
      created_by: row.author_id,
    }),
  };
}

export function listSubscriptions(userId) {
  return s().listByUser.all(userId).map(subToPublic);
}

export function countSubscriptions(userId) {
  return s().countByUser.get(userId).n;
}

/** How many catalog scopes this user has authored (their live contributions). */
export function countAuthoredScopes(userId) {
  return s().countAuthored.get(userId).n;
}

/** The shared scope catalog. `createdBy` is null for seeded scopes. */
export function listCatalog() {
  return s().listCatalog.all().map(scopeToPublic);
}

/**
 * Catalog scopes with at least one subscriber. Returned in the public shape
 * (queries parsed to an array), which is what the reporter feeds into its
 * collection pipeline.
 */
export function scopesWithSubscribers() {
  return s().scopesWithSubscribers.all().map(scopeToPublic);
}

export function getScope(scopeId) {
  return scopeToPublic(s().scopeById.get(scopeId));
}

/** Scope ids a user follows — used to build the daily feed. */
export function subscribedScopeIds(userId) {
  return s().subscribedScopeIds.all(userId).map((r) => r.scope_id);
}

/**
 * Author a new catalog scope attributed to a user. The caller must have already
 * checked the authored-scope cap. Returns:
 *   { scope }            on success
 *   { duplicateName: true } if a scope with that name already exists
 */
export function createScope(userId, { name, queries, interests }) {
  const existing = s().scopeByName.get(name);
  if (existing) return { duplicateName: true };
  const info = s().insertScope.run({
    name,
    queries: JSON.stringify(queries),
    interests: interests || null,
    created_by: userId,
  });
  return { scope: scopeToPublic(s().scopeById.get(info.lastInsertRowid)) };
}

/**
 * Subscribe a user to an existing catalog scope.
 *
 * Returns:
 *   { subscription }     on success
 *   { missing: true }    if the scope id doesn't exist
 *   { duplicate: true }  if the user already follows this scope
 */
export const subscribe = db.transaction((userId, scopeId) => {
  if (!s().scopeById.get(scopeId)) return { missing: true };
  try {
    const info = s().insertSub.run({ user_id: userId, scope_id: scopeId });
    return { subscription: subToPublic(s().subById.get(info.lastInsertRowid)) };
  } catch (err) {
    if (err.code === 'SQLITE_CONSTRAINT_UNIQUE') {
      return { duplicate: true };
    }
    throw err;
  }
});

/**
 * Remove a user's subscription. If that was the last subscriber to a
 * user-authored scope, the scope is garbage-collected from the catalog (freeing
 * the author's contribution slot). Seeded scopes (no author) are never removed.
 *
 * Returns true if a subscription was removed.
 */
export const unsubscribe = db.transaction((userId, id) => {
  const sub = s().subRowById.get(id);
  if (!sub || sub.user_id !== userId) return false;

  s().deleteOwned.run({ id, user_id: userId });

  const scope = s().scopeById.get(sub.scope_id);
  if (scope && scope.created_by != null) {
    const remaining = s().subscriberCount.get(sub.scope_id).n;
    if (remaining === 0) {
      s().deleteScope.run(scope.id);
    }
  }
  return true;
});
