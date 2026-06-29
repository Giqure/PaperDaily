// Daily scheduler: fire runReporter() at each REPORTER_DAILY_TIME and, when set,
// runPush() at each REPORTER_PUSH_TIME — both Asia/Shanghai (fixed UTC+8). No-op
// unless REPORTER_ENABLED.
//
// Either setting may list more than one time (comma-separated, e.g.
// "06:32,20:30"). Each time gets its own setTimeout-to-next-occurrence loop so it
// stays aligned to the wall clock across drift. A shared guard serializes jobs:
// a report that fires while another job runs is skipped (so arXiv fetches don't
// pile up), while a push waits out an in-progress report (so a push time close
// after a report time still delivers, just a bit later).
//
// Reporting: the first run of a day builds the digest; later runs append only
// newly-found papers. Pushing: when REPORTER_PUSH_TIME is set, report runs only
// store the digest and notifications fire at push time instead (see reporter.js).

import { runReporter, runPush } from './reporter.js';
import { parseDailyTimes } from './schedule-times.js';

const log = (...parts) => console.log('[reporter:scheduler]', ...parts);

const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

// Milliseconds from now until the next Shanghai-local HH:MM.
function msUntilNext(minutesOfDay) {
  const nowShanghai = Date.now() + SHANGHAI_OFFSET_MS;
  const dayStart = Math.floor(nowShanghai / DAY_MS) * DAY_MS; // midnight Shanghai, in epoch-ms
  let target = dayStart + minutesOfDay * 60 * 1000;
  if (target <= nowShanghai) target += DAY_MS;
  return target - nowShanghai;
}

/**
 * Arm the daily reporter (and optional push) timers. Returns a stop() function
 * (clears all pending timers) for tests/shutdown, or a no-op when disabled or no
 * valid report time is set.
 */
export function startScheduler(cfg) {
  if (!cfg.enabled) {
    log('REPORTER_ENABLED 未开启, 不安排定时任务');
    return () => {};
  }

  const reportTimes = parseDailyTimes(cfg.dailyTime, 'REPORTER_DAILY_TIME');
  if (!reportTimes.length) {
    log(`REPORTER_DAILY_TIME 无有效时间 ("${cfg.dailyTime}"), 不安排定时任务`);
    return () => {};
  }
  // Parsed once: empty when REPORTER_PUSH_TIME is unset or has no valid time, in
  // which case push runs inline at report time (see reporter.js / pushConfigured).
  const pushTimes = parseDailyTimes(cfg.pushTime, 'REPORTER_PUSH_TIME');

  // Shared guard so report and push jobs never overlap. `running` is the busy
  // flag; `runningPromise` resolves when the current job finishes, letting a
  // waiting job (push) queue behind it.
  let running = false;
  let runningPromise = Promise.resolve();
  const timers = new Set();

  // Run `fn` under the guard. mode 'skip' bails if busy (reports); mode 'wait'
  // queues behind the in-progress job (push).
  const runGuarded = async (mode, label, fn) => {
    if (running) {
      if (mode === 'skip') {
        log(`上一次运行尚未结束, 跳过本次 (${label})`);
        return;
      }
      log(`有任务进行中, 排队等待 (${label})`);
      await runningPromise.catch(() => {});
      return runGuarded(mode, label, fn); // re-check: another waiter may have won
    }
    running = true;
    let done;
    runningPromise = new Promise((resolve) => { done = resolve; });
    try {
      await fn();
    } finally {
      running = false;
      done();
    }
  };

  const runReport = (label) =>
    runGuarded('skip', label, async () => {
      const res = await runReporter(cfg);
      log(
        `定时报告完成 (${label}): ${res.date}, ${res.scopes.length} 个范围` +
          (res.append ? ' [追加]' : '')
      );
    }).catch((err) => log(`定时报告失败 (${label}):`, err?.stack || err?.message || err));

  const runPushJob = (label) =>
    runGuarded('wait', label, async () => {
      const res = await runPush(cfg);
      log(`定时推送完成 (${label}): ${res.date ?? '无日报'}`);
    }).catch((err) => log(`定时推送失败 (${label}):`, err?.stack || err?.message || err));

  // Each time re-arms itself after firing, staying aligned to the wall clock.
  const arm = (kind, { label, minutes }, job) => {
    const wait = msUntilNext(minutes);
    const fireAt = new Date(Date.now() + wait);
    log(`下次${kind}约在 ${fireAt.toISOString()} (${label} Asia/Shanghai)`);
    const timer = setTimeout(async () => {
      timers.delete(timer);
      await job(label);
      arm(kind, { label, minutes }, job);
    }, wait);
    if (typeof timer.unref === 'function') timer.unref();
    timers.add(timer);
  };

  log(`已安排 ${reportTimes.length} 个报告时间: ${reportTimes.map((t) => t.label).join(', ')}`);
  for (const time of reportTimes) arm('报告', time, runReport);

  if (pushTimes.length) {
    log(`已安排 ${pushTimes.length} 个推送时间: ${pushTimes.map((t) => t.label).join(', ')}`);
    for (const time of pushTimes) arm('推送', time, runPushJob);
  } else {
    log('未配置 REPORTER_PUSH_TIME, 推送在报告完成后内联进行');
  }

  return () => {
    for (const timer of timers) clearTimeout(timer);
    timers.clear();
  };
}
