// Must come first: loads .env into process.env before any other module
// (e.g. ./db) reads it. ESM runs imported module bodies in import order.
import './env.js';

import express from 'express';
import cors from 'cors';
import session from 'express-session';
import SqliteStoreFactory from 'better-sqlite3-session-store';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import db from './db/index.js';
import { migrate } from './db/migrate.js';
import { attachUser } from './auth/middleware.js';
import { csrfOriginCheck } from './auth/csrf.js';
import authRoutes from './auth/routes.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Apply pending DB migrations before accepting requests.
const schemaVersion = migrate();
console.log(`Database ready (schema v${schemaVersion})`);

const app = express();
const PORT = process.env.PORT || 3000;
const isProd = process.env.NODE_ENV === 'production';
const sessionSecret = process.env.SESSION_SECRET;

// Behind a proxy in prod (so secure cookies work over forwarded HTTPS).
if (isProd) app.set('trust proxy', 1);

if (isProd && !sessionSecret) {
  throw new Error('SESSION_SECRET is required in production. Set it to a long random value.');
}

if (!isProd && !sessionSecret) {
  console.warn('SESSION_SECRET is not set; using an insecure development fallback.');
}
// Credentialed CORS so the SPA on a different dev origin can send the cookie.
const allowedOrigins = (process.env.CLIENT_ORIGIN || 'http://localhost:5173')
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean);

app.use(
  cors({
    origin: allowedOrigins,
    credentials: true,
  })
);
app.use(express.json());

// Session — stored in SQLite so sessions survive restarts.
const SqliteStore = SqliteStoreFactory(session);
app.use(
  session({
    name: 'paperdaily.sid',
    store: new SqliteStore({ client: db, expired: { clear: true, intervalMs: 900_000 } }),
    secret: sessionSecret || 'dev-insecure-secret-change-me',
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      secure: isProd,
      maxAge: 1000 * 60 * 60 * 24 * 7, // 7 days
    },
  })
);

// Resolve session -> req.user for every request.
app.use(attachUser);

// CSRF defense-in-depth: reject cross-origin unsafe requests on the API.
app.use('/api', csrfOriginCheck(allowedOrigins));

// API routes
app.get('/api/health', (req, res) => {
  let dbOk = false;
  try {
    db.prepare('SELECT 1').get();
    dbOk = true;
  } catch {
    dbOk = false;
  }
  res.json({ status: 'ok', service: 'paperdaily-api', db: dbOk });
});

app.use('/api/auth', authRoutes);

app.get('/api/welcome', (req, res) => {
  res.json({
    title: 'PaperDaily',
    message: 'Your daily digest of research papers.',
  });
});

// Serve built client in production
const clientDist = path.join(__dirname, '..', '..', 'client', 'dist');
app.use(express.static(clientDist));
app.get('*', (req, res) => {
  res.sendFile(path.join(clientDist, 'index.html'));
});

const server = app.listen(PORT, () => {
  console.log(`PaperDaily API running at http://localhost:${PORT}`);
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(
      `Port ${PORT} is already in use. Another instance may be running — ` +
        `stop it, or set PORT to a free port.`
    );
    process.exit(1);
  }
  throw err;
});

// Release the port cleanly on shutdown so --watch restarts don't collide.
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
