'use strict';
const fs = require('fs');
const path = require('path');
const config = require('./config/env');

// Ensure data directory exists before DB connection is opened
const dataDir = path.dirname(path.resolve(config.dbPath));
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

const db = require('./config/db');
const app = require('./app');

// Idempotent migrate on every boot
const schema = fs.readFileSync(path.join(__dirname, 'db', 'schema.sql'), 'utf8');
db.exec(schema);

// Idempotent seed
db.prepare(`INSERT OR IGNORE INTO users (id, email) VALUES (1, 'user@balance.local')`).run();

app.listen(config.port, () => {
  console.log(`balance API running on port ${config.port} [${config.nodeEnv}]`);
});
