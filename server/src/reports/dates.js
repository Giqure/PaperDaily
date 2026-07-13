// Date helpers for on-demand reports. Kept separate from reporter.js (which
// pulls in push/scheduler transitively) so the request path can validate dates
// and build arXiv ranges without that dependency.
//
// Asia/Shanghai is a fixed UTC+8 offset (no DST), matching the reporter's APP_TZ.
// Digests are dated by this clock so on-demand runs line up with scheduled ones.

const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000;

/** Today's date in Asia/Shanghai as 'YYYY-MM-DD'. */
export function shanghaiToday() {
  return new Date(Date.now() + SHANGHAI_OFFSET_MS).toISOString().slice(0, 10);
}

/** True when `date` is a real 'YYYY-MM-DD' calendar date. */
export function isValidDate(date) {
  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
  const dt = new Date(`${date}T00:00:00Z`);
  return !Number.isNaN(dt.getTime()) && dt.toISOString().slice(0, 10) === date;
}

/**
 * arXiv submittedDate range for a picked day 'YYYY-MM-DD'. arXiv expects
 * 'YYYYMMDDHHMM' bounds; we take the whole UTC day, which matches how the
 * pipeline dates papers (by the UTC `published` field, sliced to 10 chars).
 */
export function rangeFor(date) {
  const compact = date.replace(/-/g, '');
  return { start: `${compact}0000`, end: `${compact}2359` };
}
