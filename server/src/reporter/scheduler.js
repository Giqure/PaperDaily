// Daily scheduler: fire runReporter() once per day at REPORTER_DAILY_TIME,
// interpreted in Asia/Shanghai (fixed UTC+8). No-op unless REPORTER_ENABLED.
//
// Uses a setTimeout-to-next-occurrence loop rather than a fixed 24h interval so
// it stays aligned to the wall clock across the run's own drift.

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

// Milliseconds from now until the next Shanghai-local HH:MM.
function msUntilNext(minutesOfDay) {
  const nowShanghai = Date.now() + SHANGHAI_OFFSET_MS;
  const dayStart = Math.floor(nowShanghai / DAY_MS) * DAY_MS; // midnight Shanghai, in epoch-ms
  let target = dayStart + minutesOfDay * 60 * 1000;
  if (target <= nowShanghai) target += DAY_MS;
  return target - nowShanghai;
}

/**
 * Arm the daily reporter timer. Returns a stop() function (clears the pending
 * timer) for tests/shutdown, or a no-op when disabled.
 */
export function startScheduler(cfg) {
  if (!cfg.enabled) {
    log('REPORTER_ENABLED 未开启, 不安排定时任务');
    return () => {};
  }

  const minutesOfDay = parseDailyTime(cfg.dailyTime);
  if (minutesOfDay == null) {
    log(`REPORTER_DAILY_TIME 非法 ("${cfg.dailyTime}"), 不安排定时任务`);
    return () => {};
  }

  let timer = null;
  let running = false;

  const tick = async () => {
    // Guard against an overlong run colliding with the next fire.
    if (running) {
      log('上一次运行尚未结束, 跳过本次');
    } else {
      running = true;
      try {
        const res = await runReporter(cfg);
        log(`定时运行完成: ${res.date}, ${res.scopes.length} 个范围`);
      } catch (err) {
        log('定时运行失败:', err?.stack || err?.message || err);
      } finally {
        running = false;
      }
    }
    schedule();
  };

  const schedule = () => {
    const wait = msUntilNext(minutesOfDay);
    const fireAt = new Date(Date.now() + wait);
    log(`下次运行约在 ${fireAt.toISOString()} (${cfg.dailyTime} Asia/Shanghai)`);
    timer = setTimeout(tick, wait);
    // Don't keep the event loop alive solely for the reporter.
    if (typeof timer.unref === 'function') timer.unref();
  };

  schedule();
  return () => {
    if (timer) clearTimeout(timer);
  };
}
