// Reporter configuration, read from the environment.
//
// The reporter is a Node port of the Don_daily_paper_report Python generator
// (../../../Don_daily_paper_report/embodied_daily.py). It fetches arXiv
// candidates per scope, curates them with an OpenAI-compatible chat API, and
// writes the result straight into the existing digest tables via
// importArchiveDay(). Defaults mirror that script's DEFAULT_CONFIG so digests
// produced here line up with ones imported from the Python archive.

function num(name, fallback) {
  const raw = process.env[name];
  if (raw == null || raw.trim() === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

function bool(name, fallback) {
  const raw = process.env[name];
  if (raw == null || raw.trim() === '') return fallback;
  return /^(1|true|yes|on)$/i.test(raw.trim());
}

function str(name, fallback) {
  const raw = process.env[name];
  return raw == null || raw.trim() === '' ? fallback : raw.trim();
}

export function reporterConfig() {
  return {
    // Scheduling. Disabled by default — the server only arms the daily timer
    // when explicitly enabled. The manual CLI (run-reporter.js) ignores this.
    enabled: bool('REPORTER_ENABLED', false),
    // Local run time(s), Asia/Shanghai (UTC+8, no DST). One "HH:MM", or several
    // comma-separated ("06:32,20:30") to report more than once a day. The first
    // run of a day builds the digest; later runs append only newly-found papers.
    dailyTime: str('REPORTER_DAILY_TIME', '06:32'),

    // OpenAI-compatible curation endpoint. Without a key the reporter falls
    // back to keyword tagging (no AI summaries), matching the Python behavior.
    openaiApiKey: str('OPENAI_API_KEY', ''),
    openaiBaseUrl: str('OPENAI_BASE_URL', 'https://api.openai.com/v1'),
    openaiModel: str('OPENAI_MODEL', 'gpt-4o-mini'),
    apiMaxTokens: num('OPENAI_MAX_TOKENS', 8000),
    apiRetries: num('OPENAI_RETRIES', 3),
    // Max curation requests in flight at once. Scopes are curated concurrently
    // up to this bound; arXiv fetching stays serial regardless.
    openaiConcurrency: Math.max(1, num('OPENAI_CONCURRENCY', 4)),

    // Per-scope selection knobs. The DB scope catalog only stores name/queries/
    // interests, so these globals fill in everything the per-day snapshot needs.
    topN: num('REPORTER_TOP_N', 10),
    pushN: num('REPORTER_PUSH_N', 2),
    maxCandidates: num('REPORTER_MAX_CANDIDATES', 30),
    sameDayOnly: bool('REPORTER_SAME_DAY_ONLY', true),
    lookbackDays: num('REPORTER_LOOKBACK_DAYS', 3),
    dedupDays: num('REPORTER_DEDUP_DAYS', 7),

    // arXiv politeness: pacing and retry/backoff for export.arxiv.org.
    queryDelaySeconds: Math.max(5, num('ARXIV_QUERY_DELAY_SECONDS', 5)),
    arxivMinIntervalSeconds: Math.max(3, num('ARXIV_MIN_INTERVAL_SECONDS', 5)),
    arxivRetries: Math.max(1, num('ARXIV_RETRIES', 5)),
    arxivRetryDelaySeconds: Math.max(5, num('ARXIV_RETRY_DELAY_SECONDS', 30)),
    arxivUserAgent: str(
      'ARXIV_USER_AGENT',
      'paperdaily-reporter/0.1 (+https://github.com/Doonns/Don_daily_paper_report)'
    ),

    // Optional: also dump each generated day to <dir>/YYYY-MM-DD.json for parity
    // with the Python archive and easy debugging. Unset = DB only.
    archiveDir: str('REPORTER_ARCHIVE_DIR', ''),

    // Per-user push transport. After a run, each push-enabled user receives a
    // digest of their own scopes (see reporter/push.js). Recipients, channel
    // toggles, and each user's Bark key are per-user DB state; only the shared
    // transport (Bark server, SMTP login) is operator-level config here.
    push: {
      // 'summary' (one digest), 'per_scope' (one push per scope), or
      // 'per_item' (one push per pushed paper). Mirrors the Python push_mode.
      // How many items per scope are pushed comes from each scope's push_n
      // (REPORTER_PUSH_N), set in scopeWithDefaults().
      mode: str('REPORTER_PUSH_MODE', 'summary'),

      // Bark (iOS push). Plain HTTP, no dependency. The server URL is shared;
      // each user supplies their own device key in their settings.
      bark: {
        server: str('BARK_SERVER', 'https://api.day.app'),
        bodyLimit: Math.max(800, Math.min(num('BARK_BODY_LIMIT', 3200), 3800)),
      },

      // Email (SMTP via nodemailer). The sending mailbox/login is operator-
      // level; each user receives at their own account email.
      email: {
        from: str('EMAIL_FROM', ''),
        subjectPrefix: str('EMAIL_SUBJECT_PREFIX', '论文日报'),
        smtpHost: str('SMTP_HOST', ''),
        smtpPort: num('SMTP_PORT', 465),
        smtpUser: str('SMTP_USER', ''),
        smtpPassword: str('SMTP_PASSWORD', ''),
        smtpUseSsl: bool('SMTP_USE_SSL', true),
      },
    },
  };
}

// A catalog scope (id/name/queries/interests) merged with the global selection
// knobs, producing the per-scope shape the rest of the pipeline expects.
export function scopeWithDefaults(scope, cfg) {
  return {
    id: scope.id,
    name: scope.name,
    queries: scope.queries,
    interests: scope.interests || '',
    top_n: Math.max(1, cfg.topN),
    push_n: Math.max(0, Math.min(cfg.pushN, cfg.topN)),
    max_candidates: Math.max(cfg.topN, cfg.maxCandidates),
    query_delay_seconds: cfg.queryDelaySeconds,
    same_day_only: cfg.sameDayOnly,
    lookback_days: cfg.lookbackDays,
    dedup_days: cfg.dedupDays,
  };
}
