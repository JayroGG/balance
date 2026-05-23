'use strict';
const db = require('../../config/db');
const { toCents, toDecimal } = require('../../lib/money');

const NOW = "strftime('%Y-%m-%dT%H:%M:%SZ', 'now')";

const modelGenerator = (tableName, fields) => {
  const moneyFields = fields.moneyFields || [];

  const fmt = (record) => {
    if (!record) return record;
    const out = { ...record };
    for (const f of moneyFields) {
      if (out[f] !== null && out[f] !== undefined) out[f] = toDecimal(out[f]);
    }
    return out;
  };

  const parseMoney = (data) => {
    const out = { ...data };
    for (const f of moneyFields) {
      if (out[f] !== null && out[f] !== undefined) out[f] = toCents(out[f]);
    }
    return out;
  };

  const findAll = (userId, filters = {}) => {
    const conditions = ['user_id = ?', 'deleted_at IS NULL'];
    const values = [userId];
    for (const [key, val] of Object.entries(filters)) {
      if (val !== undefined && val !== null) {
        conditions.push(`${key} = ?`);
        values.push(val);
      }
    }
    return db.prepare(
      `SELECT * FROM ${tableName} WHERE ${conditions.join(' AND ')}`
    ).all(...values).map(fmt);
  };

  const findById = (userId, id) =>
    fmt(db.prepare(
      `SELECT * FROM ${tableName} WHERE id = ? AND user_id = ? AND deleted_at IS NULL`
    ).get(id, userId));

  const create = (userId, data) => {
    const picked = {};
    for (const f of fields.create) {
      if (data[f] !== undefined) picked[f] = data[f];
    }
    const parsed = parseMoney(picked);
    const cols = ['user_id', ...Object.keys(parsed)];
    const placeholders = cols.map(() => '?').join(', ');
    const { lastInsertRowid } = db.prepare(
      `INSERT INTO ${tableName} (${cols.join(', ')}) VALUES (${placeholders})`
    ).run(userId, ...Object.values(parsed));
    return findById(userId, lastInsertRowid);
  };

  const update = (userId, id, data) => {
    const picked = {};
    for (const f of fields.update) {
      if (data[f] !== undefined) picked[f] = data[f];
    }
    if (Object.keys(picked).length === 0) return findById(userId, id);
    const parsed = parseMoney(picked);
    const sets = [...Object.keys(parsed).map((f) => `${f} = ?`), `updated_at = ${NOW}`];
    db.prepare(
      `UPDATE ${tableName} SET ${sets.join(', ')} WHERE id = ? AND user_id = ? AND deleted_at IS NULL`
    ).run(...Object.values(parsed), id, userId);
    return findById(userId, id);
  };

  const softDelete = (userId, id) =>
    db.prepare(
      `UPDATE ${tableName} SET deleted_at = ${NOW} WHERE id = ? AND user_id = ? AND deleted_at IS NULL`
    ).run(id, userId);

  return {
    findAll,
    findById,
    create,
    update,
    softDelete,
    filterFields: fields.filterFields || [],
  };
};

module.exports = { modelGenerator };
