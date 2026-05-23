'use strict';
const Database = require('better-sqlite3');
const path = require('path');
const config = require('./env');

const db = new Database(path.resolve(config.dbPath));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

module.exports = db;
