'use strict';
const db = require('../../../config/db');

// A user's own vault positions (ADR-016): ordered vaults by position, then unordered ones by
// created_at (new vaults go last). Used for GET /vaults; the balance summary does the same in SQL.
const positionsFor = (userId) =>
  new Map(db.prepare(`SELECT vault_id, position FROM vault_order WHERE user_id = ?`).all(userId)
    .map((r) => [r.vault_id, r.position]));

const sortForUser = (userId, vaults) => {
  const pos = positionsFor(userId);
  return [...vaults].sort((a, b) => {
    const pa = pos.get(a.id), pb = pos.get(b.id);
    if (pa !== undefined && pb !== undefined) return pa - pb;
    if (pa !== undefined) return -1;
    if (pb !== undefined) return 1;
    return a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : a.id - b.id;
  });
};

// Replace the caller's positions: `ids` take 0..n-1; the caller's other already-ordered vaults
// among `visibleIds` keep their relative order after them. One transaction.
const replaceOrder = (userId, ids, visibleIds) => db.transaction(() => {
  const pos = positionsFor(userId);
  const rest = visibleIds.filter((id) => pos.has(id) && !ids.includes(id))
    .sort((a, b) => pos.get(a) - pos.get(b));
  const final = [...ids, ...rest];
  const del = db.prepare(`DELETE FROM vault_order WHERE user_id = ? AND vault_id = ?`);
  const ins = db.prepare(`INSERT INTO vault_order (user_id, vault_id, position) VALUES (?, ?, ?)`);
  final.forEach((id) => del.run(userId, id));
  final.forEach((id, i) => ins.run(userId, id, i));
})();

module.exports = { sortForUser, replaceOrder };
