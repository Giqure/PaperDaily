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

