'use strict';
require('dotenv').config({ path: `.env.${process.env.NODE_ENV || 'stage'}` });

const required = ['PORT', 'DB_PATH', 'CURRENCY'];
for (const key of required) {
  if (!process.env[key]) throw new Error(`Missing required env var: ${key}`);
}

module.exports = {
  port: parseInt(process.env.PORT, 10),
  dbPath: process.env.DB_PATH,
  currency: process.env.CURRENCY,
  nodeEnv: process.env.NODE_ENV || 'stage',
};
