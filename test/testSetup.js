'use strict';
// Jest global setup — runs once before all suites. Deletes the previous run's
// SQLite test DB so every run starts from a fresh schema; suites then only
// wipe rows between tests. Must not import application code (module-level
// side effects would open the DB before it is cleaned).
const fs = require('fs');
const path = require('path');

module.exports = async () => {
  const dataDir = path.join(__dirname, '..', 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  for (const suffix of ['', '-wal', '-shm']) {
    fs.rmSync(path.join(dataDir, `balance.test.db${suffix}`), { force: true });
  }
};
