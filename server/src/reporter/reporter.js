// Reporter orchestrator: collect candidates for each subscribed scope, curate
// them, and store the result via the existing importArchiveDay(). Independent
// Node port of run_digest / gather_scope_candidates from the reference tool.

import fs from 'node:fs';
import path from 'node:path';
import { fetchQuery, parseAtom } from './arxiv.js';
import { curate } from './curate.js';
import { scopeWithDefaults } from './config.js';
import { pushToUsers } from './push.js';
import { scopesWithSubscribers } from '../subscriptions/queries.js';
import {
  importArchiveDay,
  recentArchivedExternalIds,
  dayHasDigest,
  latestDigestForPush,
} from '../digest/queries.js';
import { parseDailyTimes } from './schedule-times.js';

const log = (...parts) => console.log('[reporter]', ...parts);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Asia/Shanghai is a fixed UTC+8 offset (no DST), matching the reference tool's
// APP_TZ. Digests are dated by this clock so they line up across runs.
const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000;

function shanghaiDateStr(date = new Date()) {
  return new Date(date.getTime() + SHANGHAI_OFFSET_MS).toISOString().slice(0, 10);
}

// cutoff = today (Shanghai) minus `days`, as 'YYYY-MM-DD'.
function cutoffDateStr(days) {
  const ms = Date.now() + SHANGHAI_OFFSET_MS - days * 24 * 60 * 60 * 1000;
  return new Date(ms).toISOString().slice(0, 10);
}

function recentEnough(published, lookbackDays) {
  const dt = Date.parse(published);
  if (Number.isNaN(dt)) return true;
  return dt >= Date.now() - lookbackDays * 24 * 60 * 60 * 1000;
}

// Run `task` over `items` with at most `limit` in flight at once, preserving
// input order in the result array. Used to curate scopes concurrently while
// keeping the OpenAI request fan-out bounded.
async function mapWithConcurrency(items, limit, task) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await task(items[i], i);
    }
  }
  const workers = Array.from({ length: Math.min(limit, items.length) }, worker);
  await Promise.all(workers);
  return results;
}

/**
 * Run every query in a scope, merge + dedup by arXiv id, keep the newest batch
 * (or recent window), drop already-archived ids, and cap to max_candidates.
 */
async function gatherCandidates(scope, archivedIds, cfg) {
  const seen = new Map();
  for (let i = 0; i < scope.queries.length; i++) {
    const query = scope.queries[i];
    log(`范围[${scope.name}] 查询 ${i + 1}/${scope.queries.length}: ${query}`);
    const papers = parseAtom(await fetchQuery(query, scope.max_candidates, scope, cfg));
    for (const paper of papers) {
      if (!seen.has(paper.id)) seen.set(paper.id, paper);
    }
    if (i < scope.queries.length - 1) await sleep(scope.query_delay_seconds * 1000);
  }

  let candidates = [...seen.values()].sort((a, b) =>
    (b.published || '').localeCompare(a.published || '')
  );

  if (scope.same_day_only) {
    const dates = candidates.map((p) => (p.published || '').slice(0, 10)).filter(Boolean);
    if (dates.length) {
      const newest = dates.reduce((a, b) => (a > b ? a : b));
      candidates = candidates.filter((p) => (p.published || '').slice(0, 10) === newest);
      log(`范围[${scope.name}] 最新批次: ${newest}, ${candidates.length} 篇`);
    }
  } else {
    const recent = candidates.filter((p) => recentEnough(p.published, scope.lookback_days));
    if (recent.length >= scope.top_n) candidates = recent;
  }

  if (archivedIds.size) {
    const before = candidates.length;
    candidates = candidates.filter((p) => !archivedIds.has(p.id));
    if (before !== candidates.length) {
      log(`范围[${scope.name}] 去重: 排除 ${before - candidates.length} 篇, 剩 ${candidates.length} 篇`);
    }
  }

  return candidates.slice(0, scope.max_candidates);
}

/**
 * Generate today's digest for all subscribed scopes and store it.
 * Returns { date, scopes: [{ name, candidates, items }] } summary counts.
 */
export async function runReporter(cfg) {
  const dateStr = shanghaiDateStr();
  const catalog = scopesWithSubscribers();
  if (!catalog.length) {
    log('没有任何被订阅的 scope, 跳过');
    return { date: dateStr, scopes: [] };
  }

  // A digest already exists for today => this is a later run of the day (the
  // app can report more than once daily). Append new papers to today's digest
  // instead of rebuilding it. Dedup already hides papers surfaced earlier today,
  // so the curated results here are exactly what's new since the last run.
  const append = dayHasDigest(dateStr);
  log(
    `开始生成 ${dateStr} 日报, 共 ${catalog.length} 个被订阅范围` +
      (append ? ' (追加模式: 已有今日日报, 仅补充新论文)' : '')
  );

  // Phase 1 — gather candidates. Serial on purpose: arXiv fetches share a global
  // min-interval pacing gate, so concurrency here would just violate politeness.
  const gathered = [];
  for (const raw of catalog) {
    const scope = scopeWithDefaults(raw, cfg);
    log(`处理范围[${scope.name}]...`);
    const archivedIds = recentArchivedExternalIds(cutoffDateStr(scope.dedup_days));
    const candidates = await gatherCandidates(scope, archivedIds, cfg);
    log(`范围[${scope.name}] 候选数: ${candidates.length}`);
    gathered.push({ scope, candidates });
  }

  // Phase 2 — curate. Each scope's curation (OpenAI calls + code lookups) is
  // independent, so run them concurrently up to openaiConcurrency.
  const items = await mapWithConcurrency(gathered, cfg.openaiConcurrency, async ({ scope, candidates }) => {
    if (!candidates.length) return [];
    const curated = await curate(scope, candidates, cfg);
    log(`范围[${scope.name}] 入选数: ${curated.length}`);
    return curated;
  });

  const scopeResults = gathered.map(({ scope }, i) => ({ scope, items: items[i] }));
  const summary = gathered.map(({ scope, candidates }, i) => ({
    name: scope.name,
    candidates: candidates.length,
    items: items[i].length,
  }));

  const day = { date: dateStr, scopes: scopeResults };
  const res = importArchiveDay(day, { append });
  log(
    `已写入数据库 ${res.date}: ${res.scopes} 个范围, ${res.papers} 篇论文, ${res.links} 条关联` +
      (append ? ` (追加模式新增 ${res.links} 条)` : '')
  );

  if (cfg.archiveDir) {
    try {
      const dir = path.resolve(cfg.archiveDir);
      fs.mkdirSync(dir, { recursive: true });
      // A later run the same day writes a distinct file so the morning archive
      // isn't clobbered; the first run keeps the plain YYYY-MM-DD.json name.
      const stamp = append
        ? `${dateStr}-${new Date().toISOString().slice(11, 16).replace(':', '')}`
        : dateStr;
      const file = path.join(dir, `${stamp}.json`);
      fs.writeFileSync(file, JSON.stringify(day, null, 2), 'utf8');
      log('已存档 JSON:', file);
    } catch (err) {
      log('存档 JSON 失败 (忽略):', err.message);
    }
  }

  // Fan the digest out to every push-enabled user (Bark / email), scoped to the
  // scopes each follows. Best-effort — never blocks the stored digest. On an
  // append run that added nothing new, skip push so users aren't pinged with an
  // empty "今日没有新论文" notice for a day they already received.
  //
  // When a separate push time is configured (REPORTER_PUSH_TIME), report runs
  // only generate/store the digest — all notifications go out at push time, so
  // we skip the inline push entirely here.
  if (pushConfigured(cfg)) {
    log('已配置独立推送时间 (REPORTER_PUSH_TIME), 报告阶段不推送');
  } else if (append && res.links === 0) {
    log('追加模式未发现新论文, 跳过推送');
  } else {
    try {
      await pushToUsers(cfg, scopeResults, dateStr);
    } catch (err) {
      log('推送阶段异常 (忽略):', err?.message || err);
    }
  }

  return { date: dateStr, scopes: summary, append };
}

/** True when a dedicated push schedule is set, decoupling push from reporting. */
export function pushConfigured(cfg) {
  return parseDailyTimes(cfg.pushTime, 'REPORTER_PUSH_TIME').length > 0;
}

/**
 * Push the latest stored digest to every push-enabled user. Used by the
 * scheduler when REPORTER_PUSH_TIME is set, so notifications fire on their own
 * schedule rather than inline at report time. Reads what was already generated
 * (latestDigestForPush) instead of re-curating. Best-effort; returns a summary.
 */
export async function runPush(cfg) {
  const { date, scopeResults } = latestDigestForPush();
  if (!date) {
    log('推送: 暂无任何日报, 跳过');
    return { date: null, pushed: false };
  }
  const total = scopeResults.reduce((n, r) => n + r.items.length, 0);
  log(`推送最新日报 ${date}: ${scopeResults.length} 个范围, ${total} 篇`);
  try {
    await pushToUsers(cfg, scopeResults, date);
  } catch (err) {
    log('推送阶段异常 (忽略):', err?.message || err);
  }
  return { date, pushed: true };
}
