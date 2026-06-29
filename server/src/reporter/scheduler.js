// Daily scheduler: fire runReporter() at each REPORTER_DAILY_TIME, interpreted
// in Asia/Shanghai (fixed UTC+8). No-op unless REPORTER_ENABLED.
//
// REPORTER_DAILY_TIME may list more than one time (comma-separated, e.g.
// "06:32,20:30") to report multiple times a day. Each time gets its own
// setTimeout-to-next-occurrence loop so they stay aligned to the wall clock
// across drift. A shared running-guard serializes overlapping fires: the later
// run waits its turn rather than colliding with an in-progress run. The first
// run of a day builds the digest; later runs append only newly-found papers
// (see runReporter / importArchiveDay's append mode).

import { runReporter } from './reporter.js';

const log = (...parts) => console.log('[reporter:scheduler]', ...parts);

const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

// Parse "HH:MM" -> minutes since midnight, or null if malformed.
function parseDailyTime(value) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(value).trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

// Parse the (possibly comma-separated) REPORTER_DAILY_TIME into a sorted, de-
// duplicated list of { label, minutes }. Malformed entries are dropped with a
// warning so one bad value doesn't disable the whole schedule.
function parseDailyTimes(value) {
  const parts = String(value).split(',').map((p) => p.trim()).filter(Boolean);
  const seen = new Set();
  const times = [];
  for (const part of parts) {
    const minutes = parseDailyTime(part);
    if (minutes == null) {
      log(`REPORTER_DAILY_TIME 含非法时间 ("${part}"), 已忽略`);
      continue;
    }
    if (seen.has(minutes)) continue;
    seen.add(minutes);
    times.push({ label: part, minutes });
  }
  return times.sort((a, b) => a.minutes - b.minutes);
}

// Milliseconds from now until the next Shanghai-local HH:MM.
function msUntilNext(minutesOfDay) {
  const nowShanghai = Date.now() + SHANGHAI_OFFSET_MS;
  const dayStart = Math.floor(nowShanghai / DAY_MS) * DAY_MS; // midnight Shanghai, in epoch-ms
  let target = dayStart + minutesOfDay * 60 * 1000;
  if (target <= nowShanghai) target += DAY_MS;
  return target - nowShanghai;
}

/**
 * Arm the daily reporter timer(s). Returns a stop() function (clears all pending
 * timers) for tests/shutdown, or a no-op when disabled or no valid time is set.
 */
export function startScheduler(cfg) {
  if (!cfg.enabled) {
    log('REPORTER_ENABLED 未开启, 不安排定时任务');
    return () => {};
  }

  const times = parseDailyTimes(cfg.dailyTime);
  if (!times.length) {
    log(`REPORTER_DAILY_TIME 无有效时间 ("${cfg.dailyTime}"), 不安排定时任务`);
    return () => {};
  }

  // One running-guard shared across every time so two fires never overlap.
  let running = false;
  const timers = new Set();

  const runOnce = async (label) => {
    if (running) {
      log(`上一次运行尚未结束, 跳过本次 (${label})`);
      return;
    }
    running = true;
    try {
      const res = await runReporter(cfg);
      log(
        `定时运行完成 (${label}): ${res.date}, ${res.scopes.length} 个范围` +
          (res.append ? ' [追加]' : '')
      );
    } catch (err) {
      log(`定时运行失败 (${label}):`, err?.stack || err?.message || err);
    } finally {
      running = false;
    }
  };

  // Each time re-arms itself after firing, staying aligned to the wall clock.
  const arm = ({ label, minutes }) => {
    const wait = msUntilNext(minutes);
    const fireAt = new Date(Date.now() + wait);
    log(`下次运行约在 ${fireAt.toISOString()} (${label} Asia/Shanghai)`);
    const timer = setTimeout(async () => {
      timers.delete(timer);
      await runOnce(label);
      arm({ label, minutes });
    }, wait);
    if (typeof timer.unref === 'function') timer.unref();
    timers.add(timer);
  };

  log(`已安排 ${times.length} 个每日运行时间: ${times.map((t) => t.label).join(', ')}`);
  for (const time of times) arm(time);

  return () => {
    for (const timer of timers) clearTimeout(timer);
    timers.clear();
  };
}
