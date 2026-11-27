'use strict';
const bcrypt = require('bcryptjs');
const db = require('../config/db');
const { seedPassword, nodeEnv } = require('../config/env');

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

// Permanent local demo login. Opt-in only (SEED_DEMO_USER=true in a local .env.<env>) and never on prod or
// Fly (the Dockerfile runs this seed on every boot; Fly injects FLY_APP_NAME and its fly.toml never sets the flag).
const demoAllowed = process.env.SEED_DEMO_USER === 'true' && nodeEnv !== 'prod' && !process.env.FLY_APP_NAME;
if (demoAllowed) {
  db.prepare(
    `INSERT INTO users (email, password_hash, active, verified) VALUES ('demo@example.com', ?, 1, 1)
     ON CONFLICT(email) DO UPDATE SET password_hash = excluded.password_hash, active = 1, verified = 1, role = 'user', deleted_at = NULL`
  ).run(bcrypt.hashSync(process.env.DEMO_PASSWORD || 'demo1234', 10));
  console.log('Demo user ready: demo@example.com');
} else if (process.env.SEED_DEMO_USER === 'true') {
  console.warn('SEED_DEMO_USER ignored: refused on prod / Fly.');
}

console.log('Seed complete.');
