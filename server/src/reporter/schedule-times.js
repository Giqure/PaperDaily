// Shared parsing for the reporter's "HH:MM" schedule values (REPORTER_DAILY_TIME
// and REPORTER_PUSH_TIME). Times are Asia/Shanghai (fixed UTC+8, no DST) and may
// be comma-separated to fire more than once a day. Kept in its own module so both
// the scheduler (which arms the timers) and the reporter (which checks whether a
// separate push time is configured) can use it without a circular import.

const log = (...parts) => console.log('[reporter:schedule]', ...parts);

// Parse "HH:MM" -> minutes since midnight, or null if malformed.
export function parseDailyTime(value) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(value).trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

/**
 * Parse a (possibly comma-separated) time list into a sorted, de-duplicated
 * array of { label, minutes }. Malformed entries are dropped with a warning so
 * one bad value doesn't disable the whole schedule. `kind` only labels the log.
 */
export function parseDailyTimes(value, kind = 'REPORTER_DAILY_TIME') {
  const parts = String(value ?? '').split(',').map((p) => p.trim()).filter(Boolean);
  const seen = new Set();
  const times = [];
  for (const part of parts) {
    const minutes = parseDailyTime(part);
    if (minutes == null) {
      log(`${kind} 含非法时间 ("${part}"), 已忽略`);
      continue;
    }
    if (seen.has(minutes)) continue;
    seen.add(minutes);
    times.push({ label: part, minutes });
  }
  return times.sort((a, b) => a.minutes - b.minutes);
}
