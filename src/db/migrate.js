'use strict';
const fs = require('fs');
const path = require('path');
const db = require('../config/db');

const sql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
db.exec(sql);

// schema.sql can't ALTER existing tables; add columns introduced after first deploy.
if (!db.prepare(`PRAGMA table_info(teams)`).all().some((c) => c.name === 'color')) {
  db.exec(`ALTER TABLE teams ADD COLUMN color TEXT`);
}

if (!db.prepare(`PRAGMA table_info(transactions)`).all().some((c) => c.name === 'loan_id')) {
  db.exec(`ALTER TABLE transactions ADD COLUMN loan_id INTEGER REFERENCES loans(id)`);
}

console.log('Migration complete.');
