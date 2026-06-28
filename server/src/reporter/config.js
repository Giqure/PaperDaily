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

// Split a comma/whitespace/newline-separated env var into a clean list.
function list(name) {
  const raw = process.env[name];
  if (!raw) return [];
  return raw
    .split(/[,\n]/)
    .map((x) => x.trim())
    .filter(Boolean);
}

export function reporterConfig() {
  return {
    // Scheduling. Disabled by default — the server only arms the daily timer
    // when explicitly enabled. The manual CLI (run-reporter.js) ignores this.
    enabled: bool('REPORTER_ENABLED', false),
    // Local run time, Asia/Shanghai (UTC+8, no DST), "HH:MM".
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

    // Operator-level push: after a run, notify these channels with a summary of
    // everything generated (not per-user — see reporter/push.js). Each channel
    // is skipped silently when its required config is absent.
    push: {
      // 'summary' (one digest), 'per_scope' (one push per scope), or
      // 'per_item' (one push per pushed paper). Mirrors the Python push_mode.
      // How many items per scope are pushed comes from each scope's push_n
      // (REPORTER_PUSH_N), set in scopeWithDefaults().
      mode: str('REPORTER_PUSH_MODE', 'summary'),

      // Bark (iOS push). Plain HTTP, no dependency.
      bark: {
        server: str('BARK_SERVER', 'https://api.day.app'),
        keys: list('BARK_KEYS').length ? list('BARK_KEYS') : list('BARK_KEY'),
        bodyLimit: Math.max(800, Math.min(num('BARK_BODY_LIMIT', 3200), 3800)),
      },

      // Email (SMTP via nodemailer).
      email: {
        to: list('EMAIL_TO'),
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
