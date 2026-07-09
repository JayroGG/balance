'use strict';
// Items are scoped by their parent LIST, not by user/team — the generic user-scoped
// model would hide a teammate's items on a shared list. Access is authorized through
// the list (resolved via req.context) in the hooks; here we just key rows by list_id/id.
const db = require('../../../config/db');
const { toCents, toDecimal } = require('../../../lib/money');
const { fields } = require('./fields');
// Direct import (never via entity index) to avoid circular deps.
const { ShoppingListModel } = require('../../shopping-lists/db/model');

const NOW = "strftime('%Y-%m-%dT%H:%M:%SZ', 'now')";

const fmt = (r) => (r ? { ...r, price: r.price != null ? toDecimal(r.price) : null } : r);

// list_id is required + authorized upstream (LIST_ALL hook); we filter defensively.
const findAll = (scope, filters = {}) =>
  db.prepare(
    `SELECT * FROM shopping_list_items WHERE list_id = ? AND deleted_at IS NULL ORDER BY id`
  ).all(filters.list_id).map(fmt);

const findById = (scope, id) =>
  fmt(db.prepare(
    `SELECT * FROM shopping_list_items WHERE id = ? AND deleted_at IS NULL`
  ).get(id));

const create = (scope, data) => {
  // Inherit user_id from the parent list so ownership checks track list ownership.
  const list = ShoppingListModel.findById(scope, data.list_id);
  const price = data.price != null ? toCents(data.price) : null;
  const { lastInsertRowid } = db.prepare(
    `INSERT INTO shopping_list_items (user_id, list_id, name, qty, price, checked)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(list.user_id, data.list_id, data.name, data.qty ?? 1, price, data.checked ? 1 : 0);
  return findById(scope, lastInsertRowid);
};

const update = (scope, id, data) => {
  const sets = [];
  const vals = [];
  if (data.name !== undefined)    { sets.push('name = ?');    vals.push(data.name); }
  if (data.qty !== undefined)     { sets.push('qty = ?');     vals.push(data.qty); }
  if (data.price !== undefined)   { sets.push('price = ?');   vals.push(data.price != null ? toCents(data.price) : null); }
  if (data.checked !== undefined) { sets.push('checked = ?'); vals.push(data.checked ? 1 : 0); }
  if (sets.length === 0) return findById(scope, id);
  sets.push(`updated_at = ${NOW}`);
  db.prepare(
    `UPDATE shopping_list_items SET ${sets.join(', ')} WHERE id = ? AND deleted_at IS NULL`
  ).run(...vals, id);
  return findById(scope, id);
};

const softDelete = (scope, id) =>
  db.prepare(
    `UPDATE shopping_list_items SET deleted_at = ${NOW} WHERE id = ? AND deleted_at IS NULL`
  ).run(id);

// Cascade helper: soft-delete every active item of a list (used on list delete).
const softDeleteByList = (listId) =>
  db.prepare(
    `UPDATE shopping_list_items SET deleted_at = ${NOW} WHERE list_id = ? AND deleted_at IS NULL`
  ).run(listId);

const countChecked = (listId) =>
  db.prepare(
    `SELECT COUNT(*) AS n FROM shopping_list_items WHERE list_id = ? AND checked = 1 AND deleted_at IS NULL`
  ).get(listId).n;

const ShoppingListItemModel = {
  findAll, findById, create, update, softDelete,
  softDeleteByList, countChecked,
  filterFields: fields.filterFields,
};
module.exports = { ShoppingListItemModel };
