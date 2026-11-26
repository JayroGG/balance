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

// ADR-014: transactions gains card_id and the 'card_payment' type. SQLite can't alter a CHECK, so a
// table created before this ADR is rebuilt from schema.sql's own DDL (copy, drop, rename) with
// foreign keys off, as the SQLite docs prescribe; idempotent once the CHECK allows the new type.
const txDdl = db.prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'transactions'`).get().sql;
if (!txDdl.includes('card_payment')) {
  const target = /CREATE TABLE IF NOT EXISTS transactions \(([\s\S]*?)\n\);/.exec(sql)[0]
    .replace('CREATE TABLE IF NOT EXISTS transactions', 'CREATE TABLE transactions_new');
  const cols = db.prepare(`PRAGMA table_info(transactions)`).all().map((c) => c.name).join(', ');
  db.pragma('foreign_keys = OFF');
  try {
    db.transaction(() => {
      db.exec(target);
      db.exec(`INSERT INTO transactions_new (${cols}) SELECT ${cols} FROM transactions`);
      db.exec(`DROP TABLE transactions`);
      db.exec(`ALTER TABLE transactions_new RENAME TO transactions`);
      db.exec(sql); // recreate the indexes dropped with the old table (all IF NOT EXISTS)
      const broken = db.pragma('foreign_key_check');
      if (broken.length) throw new Error(`transactions rebuild broke foreign keys: ${JSON.stringify(broken)}`);
    })();
  } finally {
    db.pragma('foreign_keys = ON');
  }
}
db.exec(`CREATE INDEX IF NOT EXISTS idx_transactions_card ON transactions(card_id)`);

console.log('Migration complete.');
