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

// ADR-013: transactions.category_id -> transaction_categories join table. Copy, then drop
// the column (and its index) atomically; a no-op once the column is gone.
if (db.prepare(`PRAGMA table_info(transactions)`).all().some((c) => c.name === 'category_id')) {
  db.transaction(() => {
    db.exec(`INSERT OR IGNORE INTO transaction_categories (transaction_id, category_id)
             SELECT id, category_id FROM transactions WHERE category_id IS NOT NULL`);
    db.exec(`DROP INDEX IF EXISTS idx_transactions_category`);
    db.exec(`ALTER TABLE transactions DROP COLUMN category_id`);
  })();
}

console.log('Migration complete.');
