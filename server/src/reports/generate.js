// On-demand report generation: build a digest for a user-chosen date and set of
// scopes, on request rather than on the daily schedule. Reuses the scheduled
// reporter's building blocks (arxiv fetch/parse, curate, importArchiveDay) but
// targets a specific submittedDate range and skips cross-date dedup, since the
// point is to surface that date's papers even if seen elsewhere.
//
// Runs as a background job: the route creates a row and enqueues the work here
// without awaiting; status is persisted to report_jobs so the client can poll.
// A process-wide FIFO promise chain serializes on-demand jobs among themselves,
// and arxiv.js's own min-interval gate paces fetches against the scheduler.

import { fetchQuery, parseAtom } from '../reporter/arxiv.js';
import { curate } from '../reporter/curate.js';
import { reporterConfig, scopeWithDefaults } from '../reporter/config.js';
import { getScope } from '../subscriptions/queries.js';
import { importArchiveDay, digestExistsForScope } from '../digest/queries.js';
import {
  setJobRunning,
  setJobDone,
  setJobFailed,
} from './queries.js';
import { rangeFor } from './dates.js';

const log = (...parts) => console.log('[reports:generate]', ...parts);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// reporterConfig() reads env, which is fixed at boot — capture once (index.js
// does the same for the scheduler).
let _cfg;
const cfg = () => (_cfg ??= reporterConfig());

/**
 * A scope is visible to a user when it's seeded (no author) or authored by them.
 * Mirrors subscriptions/queries.js subscribe()/createScope() visibility.
 */
function scopeVisibleTo(scope, userId) {
  return scope && (scope.createdBy == null || scope.createdBy === userId);
}

/**
 * Gather arXiv candidates for a scope on a specific date. Like the scheduled
 * reporter's gatherCandidates, but bounded to `date` via a submittedDate range
 * and without cross-date dedup. A client-side filter keeps only papers whose
 * published date matches, guarding against range edge cases.
 */
async function gatherCandidatesForDate(scope, date, config) {
  const range = rangeFor(date);
  const seen = new Map();
  for (let i = 0; i < scope.queries.length; i++) {
    const query = scope.queries[i];
    log(`范围[${scope.name}] 查询 ${i + 1}/${scope.queries.length} @${date}: ${query}`);
    const xml = await fetchQuery(query, scope.max_candidates, scope, config, {
      submittedDateRange: range,
    });
    for (const paper of parseAtom(xml)) {
      if (!seen.has(paper.id)) seen.set(paper.id, paper);
    }
    if (i < scope.queries.length - 1) await sleep(scope.query_delay_seconds * 1000);
  }

  let candidates = [...seen.values()]
    // Keep only papers actually submitted on the target date. arXiv's range is
    // inclusive and UTC; slicing published to 10 chars matches how the pipeline
    // dates papers elsewhere.
    .filter((p) => (p.published || '').slice(0, 10) === date)
    .sort((a, b) => (b.published || '').localeCompare(a.published || ''));

  return candidates.slice(0, scope.max_candidates);
}

/**
 * Generate (or reuse) digests for `scopeIds` on `date`, for user `userId`.
 * Scopes not visible to the user are silently dropped (the route validates
 * first; this is defense in depth). Scopes that already have a digest that date
 * are reused as-is. Returns { reusedScopeIds, generatedScopeIds }.
 */
export async function runReportForScopes({ scopeIds, date, userId }) {
  const config = cfg();
  const reusedScopeIds = [];
  const toGenerate = [];

  for (const id of scopeIds) {
    const scope = getScope(id);
    if (!scopeVisibleTo(scope, userId)) continue;
    if (digestExistsForScope(date, id)) {
      reusedScopeIds.push(id);
    } else {
      toGenerate.push(scope);
    }
  }

  const scopeEntries = [];
  for (const raw of toGenerate) {
    const scope = scopeWithDefaults(raw, config);
    log(`生成范围[${scope.name}] @${date}...`);
    const candidates = await gatherCandidatesForDate(scope, date, config);
    log(`范围[${scope.name}] 候选数: ${candidates.length}`);
    const items = candidates.length ? await curate(scope, candidates, config) : [];
    log(`范围[${scope.name}] 入选数: ${items.length}`);
    scopeEntries.push({ scope, items });
  }

  if (scopeEntries.length) {
    // Append mode: reuse already excluded existing (date, scope) rows, so this
    // behaves like a plain insert normally and stays race-safe (INSERT OR IGNORE)
    // if the scheduled run wrote the same scope in between.
    const res = importArchiveDay({ date, scopes: scopeEntries }, { append: true });
    log(`已写入 ${res.date}: ${res.scopes} 个范围, ${res.papers} 篇, ${res.links} 条关联`);
  }

  return {
    reusedScopeIds,
    generatedScopeIds: toGenerate.map((sc) => sc.id),
  };
}

// --- Background job queue -----------------------------------------------------
// One on-demand job at a time, chained so overlapping requests don't pile arXiv
// fetches on top of each other. Status is persisted, so nothing here needs to be
// awaited by the caller.
let chain = Promise.resolve();

async function executeJob(jobId, params) {
  setJobRunning(jobId);
  try {
    const { reusedScopeIds, generatedScopeIds } = await runReportForScopes(params);
    setJobDone(jobId, reusedScopeIds, generatedScopeIds);
    log(`任务 ${jobId} 完成: 复用 ${reusedScopeIds.length}, 生成 ${generatedScopeIds.length}`);
  } catch (err) {
    setJobFailed(jobId, err?.message || err);
    log(`任务 ${jobId} 失败:`, err?.stack || err?.message || err);
  }
}

/** Enqueue a job to run in the background. Returns immediately. */
export function enqueueJob(jobId, params) {
  chain = chain.then(() => executeJob(jobId, params)).catch(() => {});
}
