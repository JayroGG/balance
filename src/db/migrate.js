'use strict';
const fs = require('fs');
const path = require('path');
const db = require('../config/db');

const sql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
db.exec(sql);
console.log('Migration complete.');
