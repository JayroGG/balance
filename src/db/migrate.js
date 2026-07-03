'use strict';
const fs = require('fs');
const path = require('path');
const db = require('../config/db');

const sql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
db.exec(sql);

// schema.sql can't ALTER existing tables; add columns introduced after first deploy.
const addColumn = (table, name, ddl) => {
  if (!db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === name)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
  }
};

addColumn('teams', 'color', 'color TEXT');
// Auto-capture (see docs/react-native-auto-capture-request.md)
addColumn('transactions', 'source_id',         'source_id INTEGER REFERENCES payment_sources(id)');
addColumn('transactions', 'capture_id',        'capture_id INTEGER REFERENCES captures(id)');
addColumn('transactions', 'transfer_group_id', 'transfer_group_id TEXT');
addColumn('sessions', 'name',  'name TEXT');
addColumn('sessions', 'scope', 'scope TEXT');

console.log('Migration complete.');
