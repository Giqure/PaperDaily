import Database from 'better-sqlite3';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Store the DB file under server/data/ (gitignored). Override with DB_PATH.
const dataDir = path.join(__dirname, '..', '..', 'data');
fs.mkdirSync(dataDir, { recursive: true });

const dbPath = process.env.DB_PATH || path.join(dataDir, 'paperdaily.sqlite');

const db = new Database(dbPath);

// Pragmas: WAL for better read/write concurrency, enforce foreign keys.
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

export default db;
