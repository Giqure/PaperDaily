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
import subscriptionRoutes from './subscriptions/routes.js';
import paperRoutes from './papers/routes.js';
import settingsRoutes from './settings/routes.js';
import reportRoutes from './reports/routes.js';
import { markInterruptedJobs } from './reports/queries.js';
import { reporterConfig } from './reporter/config.js';
import { startScheduler } from './reporter/scheduler.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Apply pending DB migrations before accepting requests.
const schemaVersion = migrate();
console.log(`Database ready (schema v${schemaVersion})`);

// Any on-demand report job still marked pending/running was interrupted by a
// previous shutdown and can't resume — fail it so clients stop polling.
const interrupted = markInterruptedJobs();
if (interrupted) console.log(`Marked ${interrupted} interrupted report job(s) as failed`);

// Arm the daily reporter timer (no-op unless REPORTER_ENABLED).
const stopScheduler = startScheduler(reporterConfig());

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

const appBaseUrl = process.env.APP_BASE_URL?.trim();
if (isProd && !appBaseUrl) {
  throw new Error('APP_BASE_URL is required in production.');
}
if (appBaseUrl) {
  let parsedAppBaseUrl;
  try {
    parsedAppBaseUrl = new URL(appBaseUrl);
  } catch {
    throw new Error('APP_BASE_URL must be an absolute http(s) URL.');
  }
  if (!['http:', 'https:'].includes(parsedAppBaseUrl.protocol)) {
    throw new Error('APP_BASE_URL must use http or https.');
  }
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
app.use('/api/subscriptions', subscriptionRoutes);
app.use('/api/papers', paperRoutes);
app.use('/api/settings', settingsRoutes);
app.use('/api/reports', reportRoutes);

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
  process.on(signal, () => {
    stopScheduler();
    server.close(() => process.exit(0));
  });
}
