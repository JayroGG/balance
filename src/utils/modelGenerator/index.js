'use strict';
const db = require('../../config/db');
const { toCents, toDecimal } = require('../../lib/money');

const NOW = "strftime('%Y-%m-%dT%H:%M:%SZ', 'now')";

const modelGenerator = (tableName, fields) => {
  const moneyFields = fields.moneyFields || [];
  const teamScoped = !!fields.teamScoped;

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

  // Build the context WHERE clause from a scope { userId, teamId }.
  // - team-scoped + teamId set -> team rows (any member); membership is verified upstream.
  // - team-scoped + no teamId  -> personal rows only (user's own, not tagged to a team).
  // - not team-scoped          -> the user's own rows (teamId ignored).
  const scopeClause = ({ userId, teamId }) => {
    if (!teamScoped) return { sql: 'user_id = ?', values: [userId] };
    return teamId != null
      ? { sql: 'team_id = ?', values: [teamId] }
      : { sql: 'user_id = ? AND team_id IS NULL', values: [userId] };
  };

  const findAll = (scope, filters = {}) => {
    const { sql, values } = scopeClause(scope);
    const conditions = [sql, 'deleted_at IS NULL'];
    const params = [...values];
    for (const [key, val] of Object.entries(filters)) {
      if (val !== undefined && val !== null) {
        conditions.push(`${key} = ?`);
        params.push(val);
      }
    }
    return db.prepare(
      `SELECT * FROM ${tableName} WHERE ${conditions.join(' AND ')}`
    ).all(...params).map(fmt);
  };

  const findById = (scope, id) => {
    const { sql, values } = scopeClause(scope);
    return fmt(db.prepare(
      `SELECT * FROM ${tableName} WHERE id = ? AND ${sql} AND deleted_at IS NULL`
    ).get(id, ...values));
  };

  const create = (scope, data) => {
    const picked = {};
    for (const f of fields.create) {
      if (data[f] !== undefined) picked[f] = data[f];
    }
    const parsed = parseMoney(picked);
    const cols = ['user_id', ...(teamScoped ? ['team_id'] : []), ...Object.keys(parsed)];
    const vals = [scope.userId, ...(teamScoped ? [scope.teamId ?? null] : []), ...Object.values(parsed)];
    const placeholders = cols.map(() => '?').join(', ');
    const { lastInsertRowid } = db.prepare(
      `INSERT INTO ${tableName} (${cols.join(', ')}) VALUES (${placeholders})`
    ).run(...vals);
    return findById(scope, lastInsertRowid);
  };

  const update = (scope, id, data) => {
    const picked = {};
    for (const f of fields.update) {
      if (data[f] !== undefined) picked[f] = data[f];
    }
    if (Object.keys(picked).length === 0) return findById(scope, id);
    const parsed = parseMoney(picked);
    const { sql, values } = scopeClause(scope);
    const sets = [...Object.keys(parsed).map((f) => `${f} = ?`), `updated_at = ${NOW}`];
    db.prepare(
      `UPDATE ${tableName} SET ${sets.join(', ')} WHERE id = ? AND ${sql} AND deleted_at IS NULL`
    ).run(...Object.values(parsed), id, ...values);
    return findById(scope, id);
  };

  const softDelete = (scope, id) => {
    const { sql, values } = scopeClause(scope);
    return db.prepare(
      `UPDATE ${tableName} SET deleted_at = ${NOW} WHERE id = ? AND ${sql} AND deleted_at IS NULL`
    ).run(id, ...values);
  };

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
