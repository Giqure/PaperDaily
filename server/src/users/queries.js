import { randomUUID } from 'node:crypto';
import db from '../db/index.js';

// Prepared statements are built lazily and memoized: preparing at import time
// would run before migrations have created the `users` table.
let stmts;
function s() {
  if (!stmts) {
    stmts = {
      insert: db.prepare(`
        INSERT INTO users (uid, email, password_hash, name)
        VALUES (@uid, @email, @password_hash, @name)
      `),
      byEmail: db.prepare('SELECT * FROM users WHERE email = ?'),
      byUid: db.prepare('SELECT * FROM users WHERE uid = ?'),
      byId: db.prepare('SELECT * FROM users WHERE id = ?'),

      // Bark is set directly from the settings form. Email is gated behind a
      // mailed confirmation link, so it has its own single-column setter below.
      updateBarkSettings: db.prepare(`
        UPDATE users SET
          bark_push_enabled = @bark_push_enabled,
          bark_key          = @bark_key
        WHERE id = @id
      `),

      setEmailPushEnabled: db.prepare(
        'UPDATE users SET email_push_enabled = @enabled WHERE id = @id'
      ),

      // Users who have at least one push channel enabled — the set the reporter
      // fans out to after generating a digest.
      withPushEnabled: db.prepare(`
        SELECT * FROM users
        WHERE email_push_enabled = 1 OR bark_push_enabled = 1
      `),
    };
  }
  return stmts;
}

/**
 * Map an internal user row to the public shape. 
 * Hide id or password_hash to clients.
 */
export function toPublic(row) {
  if (!row) return null;
  return {
    uid: row.uid,
    email: row.email,
    name: row.name,
    createdAt: row.created_at,
  };
}

export function createUser({ email, passwordHash, name }) {
  const uid = randomUUID();
  const info = s().insert.run({
    uid,
    email,
    password_hash: passwordHash,
    name: name ?? null,
  });
  return s().byId.get(info.lastInsertRowid);
}

export function findByEmail(email) {
  return s().byEmail.get(email);
}

export function findByUid(uid) {
  return s().byUid.get(uid);
}

/**
 * Map a user row to their public push settings. The Bark key is sensitive-ish
 * (it's a push capability token), but it's the user's own and they need to see
 * what's stored to edit it, so it's returned to its owner.
 */
export function toPushSettings(row) {
  if (!row) return null;
  return {
    emailPushEnabled: !!row.email_push_enabled,
    barkPushEnabled: !!row.bark_push_enabled,
    barkKey: row.bark_key ?? '',
    // The address email push goes to — the account email, shown read-only.
    email: row.email,
  };
}

/** Persist a user's Bark push settings. Returns the refreshed row. */
export function updateBarkSettings(userId, { barkPushEnabled, barkKey }) {
  s().updateBarkSettings.run({
    id: userId,
    bark_push_enabled: barkPushEnabled ? 1 : 0,
    bark_key: barkKey || null,
  });
  return s().byId.get(userId);
}

/** Flip a user's email-push flag on or off. Returns the refreshed row. */
export function setEmailPushEnabled(userId, enabled) {
  s().setEmailPushEnabled.run({ id: userId, enabled: enabled ? 1 : 0 });
  return s().byId.get(userId);
}

/** Users with at least one push channel enabled — the reporter's push targets. */
export function usersWithPushEnabled() {
  return s().withPushEnabled.all();
}

