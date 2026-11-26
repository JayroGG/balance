'use strict';
require('dotenv').config({ path: `.env.${process.env.NODE_ENV || 'stage'}` });

const nodeEnv = process.env.NODE_ENV || 'stage';
const authBypass = process.env.AUTH_BYPASS === 'true';

const required = ['PORT', 'DB_PATH', 'CURRENCY'];
for (const key of required) {
  if (!process.env[key]) throw new Error(`Missing required env var: ${key}`);
}
// Real auth needs a signing secret; only the bypass stub can run without it.
if (!authBypass && !process.env.JWT_SECRET) {
  throw new Error(
    'Missing required env var: JWT_SECRET — set it as a secret ' +
    '(fly secrets set JWT_SECRET=...), or set AUTH_BYPASS=true for stage-only dev'
  );
}

// Fail closed: the bypass must never be enabled in production.
if (authBypass && nodeEnv === 'prod') {
  throw new Error('AUTH_BYPASS must not be enabled in production');
}

// '60d' / '12h' / '30m' / '45s' -> milliseconds. Fail at boot on a malformed value.
const UNIT_MS = { s: 1000, m: 60000, h: 3600000, d: 86400000 };
const parseDuration = (raw, key) => {
  const m = /^(\d+)([smhd])$/.exec(raw);
  if (!m || Number(m[1]) <= 0) throw new Error(`${key} must look like 60d, 12h, 30m or 45s`);
  return Number(m[1]) * UNIT_MS[m[2]];
};
const refreshExpiresIn = process.env.REFRESH_EXPIRES_IN || '60d';
const refreshExpiresMs = parseDuration(refreshExpiresIn, 'REFRESH_EXPIRES_IN');

module.exports = {
  port: parseInt(process.env.PORT, 10),
  dbPath: process.env.DB_PATH,
  currency: process.env.CURRENCY,
  nodeEnv,
  authBypass,
  jwtSecret: process.env.JWT_SECRET,
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || '1h',
  refreshExpiresMs,
  seedPassword: process.env.SEED_PASSWORD || 'changeme',
};
