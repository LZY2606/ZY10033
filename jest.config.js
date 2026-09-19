/** @type {import('ts-jest').InitialOptionsTsJest} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  restoreMocks: true,
  reporters: ['default', '<rootDir>/scripts/jestTestNameReporter.js'],
  collectCoverageFrom: ['src/*.ts'],
  coveragePathIgnorePatterns: ['src/*.spec.ts', 'src/index.ts'],
};
