'use strict';
const db = require('../config/db');

db.prepare(
  `INSERT OR IGNORE INTO users (id, email) VALUES (1, 'user@balance.local')`
).run();

const defaultCategories = [
  { name: 'Salary',     kind: 'income'  },
  { name: 'Freelance',  kind: 'income'  },
  { name: 'Food',       kind: 'expense' },
  { name: 'Transport',  kind: 'expense' },
  { name: 'Health',     kind: 'expense' },
  { name: 'Utilities',  kind: 'expense' },
  { name: 'Other',      kind: 'both'    },
];

const insert = db.prepare(
  `INSERT OR IGNORE INTO categories (id, user_id, name, kind) VALUES (?, 1, ?, ?)`
);

defaultCategories.forEach((cat, i) => insert.run(i + 1, cat.name, cat.kind));

console.log('Seed complete.');
