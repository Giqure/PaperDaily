// Manually run the daily reporter once and exit. Generates today's digest for
// every subscribed scope and stores it, regardless of REPORTER_ENABLED.
//
// Usage:
//   node src/scripts/run-reporter.js
//   npm --workspace server run reporter
//
// Honors the same env as the scheduled reporter (OPENAI_*, REPORTER_*, ARXIV_*).
import '../env.js';
import { migrate } from '../db/migrate.js';
import { reporterConfig } from '../reporter/config.js';
import { runReporter } from '../reporter/reporter.js';

async function main() {
  migrate();
  const res = await runReporter(reporterConfig());
  console.log('\nDone.', JSON.stringify(res, null, 2));
}

main().catch((err) => {
  console.error('[reporter] 致命错误:', err?.stack || err?.message || err);
  process.exit(1);
});
