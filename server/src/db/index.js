import Database from 'better-sqlite3';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Default location: server/data/ (gitignored). Operators can override with the
// DB_PATH env var. DB_PATH is operator-controlled configuration, not request
// input — so this isn't a request-traversal surface — but we still resolve it
// to an absolute path (relative values would otherwise depend on the launch
// cwd) and ensure its parent directory exists so a misconfigured path fails
// loudly at boot instead of mid-request.
const defaultPath = path.join(__dirname, '..', '..', 'data', 'paperdaily.sqlite');
const dbPath = process.env.DB_PATH
  ? path.resolve(__dirname, '..', '..', process.env.DB_PATH)
  : defaultPath;

fs.mkdirSync(path.dirname(dbPath), { recursive: true });

const db = new Database(dbPath);

// Pragmas: WAL for better read/write concurrency, enforce foreign keys.
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

export default db;
