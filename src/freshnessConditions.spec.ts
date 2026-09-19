/**
 * Guard test: runs the freshness-condition counter and fails when the
 * conditions are no longer centralized (reduction vs the pre-refactor
 * baseline drops below 50%).
 */
import { execFileSync } from 'node:child_process';

describe('freshness condition guard', () => {
  it('keeps freshness conditions centralized in the decision layer', () => {
    const output = execFileSync(
      process.execPath,
      ['scripts/count-freshness-conditions.mjs'],
      { encoding: 'utf8' },
    );
    console.log(output);
    expect(output).toContain('OK: freshness conditions reduced by at least half.');
  });
});
