#!/usr/bin/env node
/**
 * Freshness-condition counter — guard script for the decision-layer refactor.
 *
 * A "freshness condition" is an expression that branches on cache-entry
 * freshness state (fresh / stale / expired / missing / refreshing):
 * comparisons against time boundaries, freshness literals, results of the
 * isExpired() primitive, or inline age math. Calls to the shared classifier
 * (getFreshness) are not conditions — they carry no branch.
 *
 * The refactor centralizes these in the side-effect-free decision layer
 * (src/decisions.ts). This script counts condition sites in production
 * sources (src/*.ts excluding tests) and verifies the total dropped by at
 * least half versus the pre-refactor baseline.
 *
 * Usage:
 *   node scripts/count-freshness-conditions.mjs                 compare baseline file vs worktree
 *   node scripts/count-freshness-conditions.mjs --ref HEAD~1    compare a git ref vs worktree
 *   node scripts/count-freshness-conditions.mjs --write-baseline [--ref HEAD]
 *
 * Exit code: 0 when the reduction is at least 50%, 1 otherwise.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const SRC_DIR = join(REPO_ROOT, 'src');
const BASELINE_PATH = join(REPO_ROOT, 'scripts', 'freshness-conditions.baseline.json');

/** Documented heuristic patterns; every match is one condition site. */
const PATTERNS = [
  ['isExpired() decision call', /\bisExpired\s*\(/g],
  ['freshness literal comparison', /[=!]=+\s*['"](?:stale|expired|fresh)['"]/g],
  ['freshness literal comparison (reversed)', /['"](?:stale|expired|fresh)['"]\s*[=!]=+/g],
  ['expired flag test', /\bexpired\s*[=!]=+\s*true\b/g],
  ['negated expired flag test', /!expired\b/g],
  ['clock boundary comparison', /\b(?:now|currentTime)\s*[<>]=?/g],
  ['ttl null check', /\bttl\s*===?\s*null\b/g],
  ['inline age comparison', /createdTime\s*\+[^\n;]*[<>]=?/g],
];

/** The definition of the primitive itself is not a decision site. */
const DEFINITION_LINE = /export function isExpired\b/;

function isProductionFile(name) {
  return name.endsWith('.ts') && !name.endsWith('.spec.ts') && name !== 'testHelpers.ts';
}

function countInSource(source) {
  let total = 0;
  const perPattern = {};
  for (const line of source.split('\n')) {
    if (DEFINITION_LINE.test(line)) continue;
    for (const [label, pattern] of PATTERNS) {
      const matches = line.match(pattern);
      if (matches) {
        total += matches.length;
        perPattern[label] = (perPattern[label] ?? 0) + matches.length;
      }
    }
  }
  return { total, perPattern };
}

function listFilesAtRef(ref) {
  return execFileSync('git', ['ls-tree', '--name-only', ref, 'src/'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  })
    .split('\n')
    .map((f) => f.trim())
    .filter(Boolean);
}

function readAtRef(ref, file) {
  try {
    return execFileSync('git', ['show', `${ref}:${file}`], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return null;
  }
}

function countWorktree() {
  const files = {};
  for (const name of readdirSync(SRC_DIR).filter(isProductionFile).sort()) {
    files[`src/${name}`] = countInSource(readFileSync(join(SRC_DIR, name), 'utf8'));
  }
  return files;
}

function countRef(ref) {
  const files = {};
  for (const file of listFilesAtRef(ref).filter(isProductionFile)) {
    const source = readAtRef(ref, file);
    if (source !== null) {
      files[file] = countInSource(source);
    }
  }
  return files;
}

function totalOf(files) {
  return Object.values(files).reduce((sum, f) => sum + f.total, 0);
}

function mergePatterns(files) {
  const merged = {};
  for (const f of Object.values(files)) {
    for (const [label, count] of Object.entries(f.perPattern)) {
      merged[label] = (merged[label] ?? 0) + count;
    }
  }
  return merged;
}

function parseArgs(argv) {
  const args = { ref: null, writeBaseline: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--ref') args.ref = argv[++i];
    else if (argv[i] === '--write-baseline') args.writeBaseline = true;
    else throw new Error(`unknown argument: ${argv[i]}`);
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));

if (args.writeBaseline) {
  const files = args.ref ? countRef(args.ref) : countWorktree();
  const baseline = {
    description:
      'Pre-refactor freshness-condition counts (see scripts/count-freshness-conditions.mjs)',
    generatedFrom: args.ref
      ? `git ref ${args.ref}`
      : execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim(),
    patterns: PATTERNS.map(([label]) => label),
    total: totalOf(files),
    files: Object.fromEntries(
      Object.entries(files).map(([file, { total }]) => [file, total]),
    ),
  };
  writeFileSync(BASELINE_PATH, JSON.stringify(baseline, null, 2) + '\n');
  console.log(`Baseline written to ${BASELINE_PATH} (total: ${baseline.total})`);
  process.exit(0);
}

const before = args.ref
  ? countRef(args.ref)
  : Object.fromEntries(
      Object.entries(JSON.parse(readFileSync(BASELINE_PATH, 'utf8')).files).map(
        ([file, total]) => [file, { total, perPattern: {} }],
      ),
    );
const after = countWorktree();

const beforeTotal = totalOf(before);
const afterTotal = totalOf(after);
const origin = args.ref ? `git ref ${args.ref}` : 'baseline file';

console.log(`Freshness condition sites (${origin} -> worktree):`);
for (const file of [...new Set([...Object.keys(before), ...Object.keys(after)])].sort()) {
  const b = before[file]?.total ?? 0;
  const a = after[file]?.total ?? 0;
  console.log(`  ${file.padEnd(28)} ${String(b).padStart(3)} -> ${a}`);
}
console.log(`  ${'TOTAL'.padEnd(28)} ${String(beforeTotal).padStart(3)} -> ${afterTotal}`);

console.log('\nAfter-state breakdown by pattern:');
for (const [label, count] of Object.entries(mergePatterns(after))) {
  console.log(`  ${label}: ${count}`);
}

const reduction = beforeTotal === 0 ? 0 : (beforeTotal - afterTotal) / beforeTotal;
console.log(`\nReduction: ${(reduction * 100).toFixed(1)}% (required: >= 50%)`);
if (reduction < 0.5) {
  console.error('FAIL: freshness conditions were not reduced by at least half.');
  process.exit(1);
}
console.log('OK: freshness conditions reduced by at least half.');
