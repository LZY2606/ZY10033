/**
 * Additional jest reporter that prints every test case name.
 * Jest 30's default reporter no longer prints individual results with
 * --verbose, so this runs alongside it (jest.config.js `reporters`).
 */
class TestNameReporter {
  onTestResult(_test, testResult) {
    const lines = [];
    for (const result of testResult.testResults) {
      if (result.status === 'pending') {
        continue;
      }
      const icon = result.status === 'passed' ? '✓' : '✗';
      lines.push(`    ${icon} ${[...result.ancestorTitles, result.title].join(' › ')}`);
    }
    if (lines.length > 0) {
      process.stderr.write(`${lines.join('\n')}\n`);
    }
  }
}

module.exports = TestNameReporter;
