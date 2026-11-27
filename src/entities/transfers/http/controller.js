'use strict';
const db = require('../../../config/db');
const { TransferModel } = require('../db/model');
const { toCents, toDecimal } = require('../../../lib/money');
const { assertRealOwner } = require('../../../lib/access');
const { roleOf } = require('../../teams/db/members');
const { consumePermit, fail } = require('../../auth/http/stepUp');
const { EventModel } = require('../../events/db/model');
// Cross-entity modules imported directly to avoid circular index deps.
const { TransactionModel } = require('../../transactions/db/model');
const history = require('../../vaults/db/history');
const { availableCents, vaultBalanceCents } = require('../../balance/db/queries');

const httpError = (message, status) => Object.assign(new Error(message), { status });
const MAX_CENTS = 1e12;
const MAX_DESCRIPTION = 500;

const parseCents = (raw, name) => {
  const cents = typeof raw === 'number' ? toCents(raw) : NaN;
  if (!Number.isInteger(cents) || cents < 1 || cents > MAX_CENTS) throw httpError(`${name} must be a positive number`, 400);
  return cents;
};

const isoDate = (raw) => {
  const m = typeof raw === 'string' && /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
  const d = m && new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  if (!d || d.toISOString().slice(0, 10) !== raw) throw httpError('occurred_at must be a valid YYYY-MM-DD date', 400);
  return raw;
};

// No admin bypass (ADR-017): admin ?user_id= targeting is rejected outright.
const assertNoAdminTargeting = (req) => {
  if (req.context.targetUserId != null || req.query.user_id !== undefined) {
    throw httpError('Transfers cannot target another user', 403);
  }
};

// One side's event: the actor's feed for personal, the team's feed otherwise.
const logBoth = (actorId, t, { fromAction, toAction, fromSummary, toSummary }) => {
  EventModel.log({ userId: actorId, teamId: t.from_team_id, entity: 'transfer', entityId: t.id, action: fromAction, summary: fromSummary });
  EventModel.log({ userId: actorId, teamId: t.to_team_id, entity: 'transfer', entityId: t.id, action: toAction, summary: toSummary });
};

// Books the two linked ledger rows (out of `from`, into `to`) for a transfer row.
const bookRows = (actorId, id, t, amountCents) => {
  TransactionModel.createTransferRow({ userId: actorId, teamId: t.from_team_id },
    { type: 'transfer_out', amountCents, description: t.description, transferId: id, occurredAt: t.occurred_at });
  TransactionModel.createTransferRow({ userId: actorId, teamId: t.to_team_id },
    { type: 'transfer_in', amountCents, description: t.description, transferId: id, occurredAt: t.occurred_at });
};

// Validates the optional vault split against the source's current balances. Returns [{ vault, cents }].
const planVaultParts = (scope, available, amountCents, rawVaults) => {
  const parts = rawVaults ?? [];
  if (!Array.isArray(parts)) throw httpError('vaults must be an array', 400);
  const gap = amountCents - available;
  if (gap <= 0) {
    if (parts.length) throw httpError('vaults must be empty when available covers the amount', 400);
    return [];
  }
  const seen = new Set();
  let sum = 0;
  const plan = parts.map((p) => {
    if (!p || !Number.isInteger(p.vault_id) || p.vault_id <= 0) throw httpError('vaults[].vault_id must be a positive integer', 400);
    if (seen.has(p.vault_id)) throw httpError('vaults must not repeat a vault', 400);
    seen.add(p.vault_id);
    const cents = parseCents(p.amount, 'vaults[].amount');
    const own = scope.teamId != null ? 'team_id = ?' : 'team_id IS NULL AND user_id = ?';
    const vault = db.prepare(`SELECT id, name FROM vaults WHERE id = ? AND deleted_at IS NULL AND ${own}`)
      .get(p.vault_id, scope.teamId != null ? scope.teamId : scope.userId);
    if (!vault) throw httpError('vaults must reference live vaults of the source context', 400);
    if (cents > vaultBalanceCents(scope, vault.id)) throw httpError(`Vault "${vault.name}" has insufficient balance`, 400);
    sum += cents;
    return { vault, cents };
  });
  if (sum !== gap) {
    throw httpError(sum < gap
      ? 'Insufficient funds: available plus the chosen vault amounts do not cover the transfer'
      : 'Vault amounts must equal the shortfall (amount - available) exactly', 400);
  }
  return plan;
};

const commitCreate = db.transaction((req, input) => {
  consumePermit(req);
  const actorId = req.userId;
  const from = input.fromTeamId;
  const to = input.toTeamId;
  assertRealOwner(actorId, from);
  assertRealOwner(actorId, to);
  if (from === to) throw httpError('Source and destination must differ', 400);

  const src = { userId: actorId, teamId: from };
  const plan = planVaultParts(src, availableCents(src), input.amountCents, input.vaults);

  const id = TransferModel.insert({ userId: actorId, fromTeamId: from, toTeamId: to, amountCents: input.amountCents,
    description: input.description, occurredAt: input.occurredAt });
  const t = TransferModel.raw(id);
  for (const { vault, cents } of plan) {
    history.add(actorId, vault.id, 'withdraw', cents, id);
    EventModel.log({ userId: actorId, teamId: from, entity: 'vault', entityId: vault.id, action: 'withdrawn',
      summary: { name: vault.name, amount: toDecimal(cents), transfer_id: id } });
  }
  bookRows(actorId, id, t, input.amountCents);
  const v = TransferModel.view(t);
  const amount = toDecimal(input.amountCents);
  logBoth(actorId, t, {
    fromAction: 'sent', toAction: 'received',
    fromSummary: { amount, description: t.description, counterpart: v.to_label, transfer_id: id },
    toSummary:   { amount, description: t.description, counterpart: v.from_label, transfer_id: id },
  });
  return v;
});

// POST /transfers { to_team_id|null, amount, description?, occurred_at?, vaults? } — source = active context.
const create = (req, res, next) => {
  try {
    assertNoAdminTargeting(req);
    const { to_team_id, amount, description, occurred_at, vaults } = req.body;
    if (to_team_id === undefined) throw httpError('Missing required field: to_team_id (null = personal)', 400);
    if (to_team_id !== null && (!Number.isInteger(to_team_id) || to_team_id <= 0)) {
      throw httpError('to_team_id must be a positive integer or null', 400);
    }
    if (amount === undefined || amount === null) throw httpError('Missing required field: amount', 400);
    const amountCents = parseCents(amount, 'amount');
    if (description !== undefined && description !== null
        && (typeof description !== 'string' || description.length > MAX_DESCRIPTION)) {
      throw httpError(`description must be a string up to ${MAX_DESCRIPTION} characters`, 400);
    }
    const occurredAt = occurred_at == null ? null : isoDate(occurred_at);

    const view = commitCreate(req, {
      fromTeamId: req.context.teamId ?? null, toTeamId: to_team_id,
      amountCents, description: description ?? null, occurredAt, vaults,
    });
    res.status(201).json(view);
  } catch (e) { fail(res, next, e); }
};

const commitReverse = db.transaction((req, id) => {
  consumePermit(req);
  const actorId = req.userId;
  const orig = TransferModel.raw(id);
  // Personal sides belong to the original actor only; team sides to their real owners.
  const sideRole = (teamId) => (teamId == null ? (orig?.user_id === actorId ? 'owner' : undefined) : roleOf(actorId, teamId));
  if (!orig || (!sideRole(orig.from_team_id) && !sideRole(orig.to_team_id))) throw httpError('Transfer not found', 404);
  if (sideRole(orig.from_team_id) !== 'owner' || sideRole(orig.to_team_id) !== 'owner') {
    throw httpError('You must be an owner of both contexts', 403);
  }
  if (orig.reversal_of != null) throw httpError('A reversal cannot be reversed', 400);
  if (TransferModel.view(orig).reversed_by != null) throw httpError('Transfer already reversed', 400);

  // The money must still be where it landed: destination available >= amount.
  const dst = { userId: orig.user_id, teamId: orig.to_team_id };
  if (availableCents(dst) < orig.amount) throw httpError('Destination no longer has the funds to reverse this transfer', 400);

  const rid = TransferModel.insert({ userId: actorId, fromTeamId: orig.to_team_id, toTeamId: orig.from_team_id,
    amountCents: orig.amount, description: orig.description, reversalOf: orig.id });
  const r = TransferModel.raw(rid);
  bookRows(actorId, rid, r, r.amount);

  // Return each original vault part (never beyond what the source can still lock, ADR-012); a deleted
  // vault's share simply stays in available.
  const src = { userId: orig.user_id, teamId: orig.from_team_id };
  let room = availableCents(src);
  for (const part of TransferModel.originalVaultWithdraws(orig.id)) {
    const cents = Math.min(part.amount, Math.max(room, 0));
    if (!part.live || cents <= 0) continue;
    room -= cents;
    history.add(actorId, part.vault_id, 'allocate', cents, rid);
    const name = db.prepare(`SELECT name FROM vaults WHERE id = ?`).get(part.vault_id).name;
    EventModel.log({ userId: actorId, teamId: orig.from_team_id, entity: 'vault', entityId: part.vault_id, action: 'allocated',
      summary: { name, amount: toDecimal(cents), transfer_id: rid } });
  }

  const v = TransferModel.view(r);
  const amount = toDecimal(r.amount);
  logBoth(actorId, r, {
    fromAction: 'reversed', toAction: 'reversed',
    fromSummary: { amount, description: r.description, counterpart: v.to_label, transfer_id: rid, reversal_of: orig.id },
    toSummary:   { amount, description: r.description, counterpart: v.from_label, transfer_id: rid, reversal_of: orig.id },
  });
  return v;
});

// POST /transfers/:id/reverse — undo = a NEW opposite transfer (devolución); nothing is edited or deleted.
const reverse = (req, res, next) => {
  try {
    assertNoAdminTargeting(req);
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) throw httpError('Transfer not found', 404);
    res.status(201).json(commitReverse(req, id));
  } catch (e) { fail(res, next, e); }
};

const list = (req, res, next) => {
  try { res.json(TransferModel.list(req.context)); } catch (e) { next(e); }
};

const get = (req, res, next) => {
  try {
    const t = TransferModel.findVisible(req.context, Number(req.params.id));
    if (!t) throw httpError('Transfer not found', 404);
    res.json(t);
  } catch (e) { next(e); }
};

module.exports = { create, reverse, list, get };
