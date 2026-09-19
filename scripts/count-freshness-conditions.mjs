#!/usr/bin/env node
/**
 * Counts freshness-decision conditions in production code.
 *
 * The decision layer (src/decisions.ts + src/isExpired.ts) is the single
 * place where fresh / stale / expired / missing / refreshing states are
 * classified. The execution layer (everything else in src/) should only
 * consume action plans and perform side effects.
 *
 * Usage:
 *   node scripts/count-freshness-conditions.mjs            # working tree
 *   node scripts/count-freshness-conditions.mjs --ref=HEAD # git ref
 *
 * Reproduce the before/after numbers of the decision-layer refactoring:
 *   node scripts/count-freshness-conditions.mjs --ref=HEAD   # before
 *   node scripts/count-freshness-conditions.mjs              # after
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';

const DECISION_LAYER = new Set(['src/decisions.ts', 'src/isExpired.ts']);
const EXCLUDED = (file) =>
  file.endsWith('.spec.ts') || file === 'src/testHelpers.ts';

/** Each pattern is one kind of freshness / staleness / refresh condition */
const CONDITION_PATTERNS = [
  ['isExpired(...)', /isExpired\(/g],
  ['getFreshness(...)', /getFreshness\(/g],
  ["'expired' word", /\bexpired\b/g],
  ["'staleRefresh' word", /\bstaleRefresh\b/g],
  ["'stale' literal", /'stale'/g],
  ['createdTime + ...', /createdTime\s*\+/g],
  ['fallbackToCache < ...', /fallbackToCache\s*</g],
];
const CLOCK_PATTERN = /Date\.now\(/g;
const PLAN_PATTERN = /\bplan(CacheRead|CheckedCacheValue|PendingValue|CacheFallback|FreshValueWrite|SoftPurge)\(/g;

const refArg = process.argv.find((arg) => arg.startsWith('--ref='));
const ref = refArg ? refArg.slice('--ref='.length) : null;

function listFiles() {
  if (ref) {
    return execFileSync('git', ['ls-tree', '-r', '--name-only', ref, 'src'], {
      encoding: 'utf8',
    })
      .trim()
      .split('\n')
      .filter((file) => file.endsWith('.ts') && !EXCLUDED(file));
  }
  return readdirSync('src')
    .filter((file) => file.endsWith('.ts'))
    .map((file) => `src/${file}`)
    .filter((file) => file.endsWith('.ts') && !EXCLUDED(file));
}

function readFile(file) {
  if (ref) {
    return execFileSync('git', ['show', `${ref}:${file}`], {
      encoding: 'utf8',
    });
  }
  return readFileSync(file, 'utf8');
}

function count(source, pattern) {
  pattern.lastIndex = 0;
  return (source.match(pattern) || []).length;
}

const rows = [];
for (const file of listFiles()) {
  const source = readFile(file);
  const layer = DECISION_LAYER.has(file) ? 'decision' : 'execution';
  const conditions = CONDITION_PATTERNS.map(([label, pattern]) => ({
    label,
    count: count(source, pattern),
  })).filter(({ count }) => count > 0);
  rows.push({
    file,
    layer,
    conditions,
    conditionTotal: conditions.reduce((sum, { count }) => sum + count, 0),
    clockReads: count(source, CLOCK_PATTERN),
    planCalls: count(source, PLAN_PATTERN),
  });
}

const where = ref ? `git ref ${ref}` : 'working tree';
console.log(`# Freshness condition count (${where})\n`);
for (const row of rows) {
  if (row.conditionTotal === 0 && row.clockReads === 0 && row.planCalls === 0)
    continue;
  const detail = row.conditions
    .map(({ label, count }) => `${label}×${count}`)
    .join(', ');
  console.log(
    `${row.layer.padEnd(9)} ${row.file.padEnd(24)} ` +
      `conditions=${String(row.conditionTotal).padStart(2)} ` +
      `clockReads=${row.clockReads} planCalls=${row.planCalls}` +
      (detail ? `  [${detail}]` : ''),
  );
}

const sum = (layer, key) =>
  rows
    .filter((row) => row.layer === layer)
    .reduce((total, row) => total + row[key], 0);

const execution = sum('execution', 'conditionTotal');
const decision = sum('decision', 'conditionTotal');
console.log(`\nexecution-layer freshness conditions: ${execution}`);
console.log(`decision-layer freshness conditions:  ${decision}`);
console.log(
  `clock reads (Date.now): execution=${sum('execution', 'clockReads')} ` +
    `decision=${sum('decision', 'clockReads')}`,
);
console.log(`decision plan calls in execution layer: ${sum('execution', 'planCalls')}`);
