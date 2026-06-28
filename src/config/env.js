'use strict';
require('dotenv').config({ path: `.env.${process.env.NODE_ENV || 'stage'}` });

const nodeEnv = process.env.NODE_ENV || 'stage';
const authBypass = process.env.AUTH_BYPASS === 'true';

const required = ['PORT', 'DB_PATH', 'CURRENCY'];
// Real auth needs a signing secret; only the bypass stub can run without it.
if (!authBypass) required.push('JWT_SECRET');
for (const key of required) {
  if (!process.env[key]) throw new Error(`Missing required env var: ${key}`);
}

// Fail closed: the bypass must never be enabled in production.
if (authBypass && nodeEnv === 'prod') {
  throw new Error('AUTH_BYPASS must not be enabled in production');
}

module.exports = {
  port: parseInt(process.env.PORT, 10),
  dbPath: process.env.DB_PATH,
  currency: process.env.CURRENCY,
  nodeEnv,
  authBypass,
  jwtSecret: process.env.JWT_SECRET,
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || '7d',
  seedPassword: process.env.SEED_PASSWORD || 'changeme',
};
