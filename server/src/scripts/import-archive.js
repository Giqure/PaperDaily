// Import daily digest archive files (archive/YYYY-MM-DD.json) into the database.
//
// Usage:
//   node src/scripts/import-archive.js <dir-or-file> [<file> ...]
//
// Examples:
//   node src/scripts/import-archive.js ../../Don_daily_paper_report/archive
//   node src/scripts/import-archive.js ../../Don_daily_paper_report/archive/2026-06-22.json
//
// Idempotent: re-importing a day replaces that day's scope membership.
import '../env.js';
import fs from 'node:fs';
import path from 'node:path';
import { migrate } from '../db/migrate.js';
import { importArchiveDay } from '../digest/queries.js';

function collectFiles(args) {
  const files = [];
  for (const arg of args) {
    const abs = path.resolve(arg);
    let stat;
    try {
      stat = fs.statSync(abs);
    } catch {
      console.error(`Skipping ${arg}: not found.`);
      continue;
    }
    if (stat.isDirectory()) {
      for (const name of fs.readdirSync(abs)) {
        if (name.endsWith('.json')) files.push(path.join(abs, name));
      }
    } else if (abs.endsWith('.json')) {
      files.push(abs);
    } else {
      console.error(`Skipping ${arg}: not a .json file or directory.`);
    }
  }
  return files.sort();
}

function main() {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    console.error('Usage: node src/scripts/import-archive.js <dir-or-file> [...]');
    process.exit(1);
  }

  migrate();

  const files = collectFiles(args);
  if (files.length === 0) {
    console.error('No archive files to import.');
    process.exit(1);
  }

  const totals = { days: 0, scopes: 0, links: 0 };
  for (const file of files) {
    let day;
    try {
      day = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (err) {
      console.error(`Skipping ${path.basename(file)}: invalid JSON (${err.message}).`);
      continue;
    }
    if (!day?.date || !Array.isArray(day.scopes)) {
      console.error(`Skipping ${path.basename(file)}: missing date/scopes.`);
      continue;
    }

    const res = importArchiveDay(day);
    totals.days++;
    totals.scopes += res.scopes;
    totals.links += res.links;
    console.log(
      `Imported ${res.date}: ${res.scopes} scopes, ${res.papers} papers, ${res.links} links`
    );
  }

  console.log(
    `\nDone. ${totals.days} day(s), ${totals.scopes} scope rows, ${totals.links} scope-paper links.`
  );
}

main();
