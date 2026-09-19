/** @type {import('ts-jest').InitialOptionsTsJest} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  verbose: true,
  reporters: ['default'],
  restoreMocks: true,
  collectCoverageFrom: ['src/*.ts'],
  coveragePathIgnorePatterns: ['src/*.spec.ts', 'src/index.ts'],
};
