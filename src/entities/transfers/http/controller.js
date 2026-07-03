'use strict';
const crypto = require('crypto');
const db = require('../../../config/db');
// Import db files directly to avoid circular entity-index deps.
const { TransactionModel } = require('../../transactions/db/model');
const { availableCents } = require('../../balance/db/queries');
const { teamExists, roleOf } = require('../../teams/db/members');
const { toCents } = require('../../../lib/money');

const httpError = (message, status) => Object.assign(new Error(message), { status });

// A transfer end is a context: null = personal (always writable), or a team the
// caller must belong to with a write-capable role. Mirrors resolveContext's
// error semantics. Returns the scope used for the leg's transaction.
const resolveEnd = (req, teamId) => {
  if (teamId == null) return { userId: req.userId, teamId: null, role: null, isAdmin: req.isAdmin };
  if (!Number.isInteger(teamId) || teamId <= 0) throw httpError('team_id must be a positive integer', 400);
  if (!teamExists(teamId)) throw httpError('Team not found', 404);
  const role = req.isAdmin ? 'owner' : roleOf(req.userId, teamId);
  if (!role) throw httpError('Not a member of this team', 403);
  if (role === 'guest') throw httpError('Guests have read-only access', 403);
  return { userId: req.userId, teamId, role, isAdmin: req.isAdmin };
};

// One atomic two-legged move of money between two of the caller's contexts:
// expense in `from`, income in `to`, paired by a shared transfer_group_id.
const create = (req, res, next) => {
  try {
    const { amount, from_team_id, to_team_id, description } = req.body;
    const amountCents = toCents(amount ?? 0);
    if (!Number.isInteger(amountCents) || amountCents <= 0) {
      throw httpError('amount must be a positive number', 400);
    }
    const fromTeam = from_team_id ?? null;
    const toTeam = to_team_id ?? null;
    if (fromTeam === toTeam) throw httpError('from and to contexts must differ', 400);

    const fromScope = resolveEnd(req, fromTeam);
    const toScope = resolveEnd(req, toTeam);

    // The expense leg obeys the from-context's available-never-negative rule.
    if (amountCents > availableCents(fromScope)) {
      throw httpError('Insufficient available balance: the amount exceeds spendable money (funds are allocated to vaults)', 400);
    }

    const groupId = crypto.randomUUID();
    const desc = description ?? 'Transfer';
    const stamp = db.prepare(`UPDATE transactions SET transfer_group_id = ? WHERE id = ?`);
    const [fromTx, toTx] = db.transaction(() => {
      const out = TransactionModel.create(fromScope, { type: 'expense', amount, description: desc });
      const inn = TransactionModel.create(toScope, { type: 'income', amount, description: desc });
      stamp.run(groupId, out.id);
      stamp.run(groupId, inn.id);
      return [TransactionModel.findById(fromScope, out.id), TransactionModel.findById(toScope, inn.id)];
    })();

    res.status(201).json({ transfer_group_id: groupId, from: fromTx, to: toTx });
  } catch (e) { next(e); }
};

// Deleting a transfer removes BOTH legs atomically (legs are never deleted
// individually — the transactions hooks 400 that). The caller needs mutate
// rights on each leg's context, and removing the income leg must not push
// that context's available below zero.
const destroy = (req, res, next) => {
  try {
    const legs = db.prepare(
      `SELECT * FROM transactions WHERE transfer_group_id = ? AND deleted_at IS NULL`
    ).all(req.params.group_id);
    if (legs.length === 0) throw httpError('Transfer not found', 404);

    // Visibility first: a caller related to NO leg gets a 404 (the transfer is
    // hidden); one who can see any leg gets capability errors (403) instead.
    const relationOf = (leg) => {
      if (req.isAdmin) return 'owner';
      if (leg.team_id == null) return leg.user_id === req.userId ? 'own' : null;
      return roleOf(req.userId, leg.team_id) || null;
    };
    const relations = legs.map(relationOf);
    if (relations.every((r) => r == null)) throw httpError('Transfer not found', 404);

    legs.forEach((leg, i) => {
      const rel = relations[i];
      if (rel === 'own' || rel === 'owner') return;
      if (rel === 'guest') throw httpError('Guests have read-only access', 403);
      if (rel === 'member' && leg.user_id === req.userId) return;
      if (rel === 'member') throw httpError('Members can only modify records they created', 403);
      throw httpError('You need write access to both contexts of this transfer', 403);
    });

    const scopes = legs.map((leg, i) => ({
      userId: req.userId, teamId: leg.team_id, role: leg.team_id == null ? null : relations[i], isAdmin: req.isAdmin,
    }));

    legs.forEach((leg, i) => {
      if (leg.type === 'income' && availableCents(scopes[i]) - leg.amount < 0) {
        throw httpError('Insufficient available balance: the amount exceeds spendable money (funds are allocated to vaults)', 400);
      }
    });

    const del = db.prepare(
      `UPDATE transactions SET deleted_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE id = ?`
    );
    db.transaction(() => legs.forEach((leg) => del.run(leg.id)))();
    res.status(204).send();
  } catch (e) { next(e); }
};

module.exports = { create, destroy };
