'use strict';
// Suites share one SQLite test DB (data/balance.test.db) and wipe rows between
// tests, so the npm script runs them serially (--runInBand) — same approach as
// llm-insights. The global setup deletes the DB file so each run starts fresh.
module.exports = {
  testEnvironment: 'node',
  testMatch: ['<rootDir>/test/**/*.test.js'],
  globalSetup: './test/testSetup.js',
  testTimeout: 10000,
};
