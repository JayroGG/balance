'use strict';
const bcrypt = require('bcryptjs');
const db = require('../config/db');
const { seedPassword } = require('../config/env');

db.prepare(
  `INSERT OR IGNORE INTO users (id, email) VALUES (1, 'user@balance.local')`
).run();
db.prepare(
  `UPDATE users SET active = 1, verified = 1, password_hash = ? WHERE id = 1`
).run(bcrypt.hashSync(seedPassword, 10));

// A team owned by user 1 + its owner membership, so team-context flows are
// testable under the AUTH_BYPASS stub.
db.prepare(`INSERT OR IGNORE INTO teams (id, user_id, name) VALUES (1, 1, 'Household')`).run();
db.prepare(
  `INSERT OR IGNORE INTO team_members (team_id, user_id, role) VALUES (1, 1, 'owner')`
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
