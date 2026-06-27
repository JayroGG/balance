'use strict';
const { VaultModel } = require('../db/model');
const history = require('../db/history');
const { toCents, toDecimal } = require('../../../lib/money');
// Import balance queries directly to avoid circular index deps
const { availableCents, vaultBalanceCents } = require('../../balance/db/queries');

// Vault record + its derived balance (the shape the mobile client consumes).
const vaultView = (userId, vault) => ({
  id:      vault.id,
  name:    vault.name,
  balance: toDecimal(vaultBalanceCents(userId, vault.id)),
  target:  vault.target_amount !== null && vault.target_amount !== undefined ? vault.target_amount : null,
});

// Resolve { amount } from the body into positive cents, or throw 400.
const parseAmount = (raw) => {
  if (raw === undefined || raw === null) { const e = new Error('Missing required field: amount'); e.status = 400; throw e; }
  const cents = toCents(raw);
  if (!Number.isInteger(cents) || cents <= 0) { const e = new Error('amount must be a positive number'); e.status = 400; throw e; }
  return cents;
};

const requireVault = (userId, vaultId) => {
  const vault = VaultModel.findById(userId, vaultId);
  if (!vault) { const e = new Error('Vault not found'); e.status = 404; throw e; }
  return vault;
};

const getHistory = (req, res, next) => {
  try {
    const vaultId = Number(req.params.id);
    requireVault(req.userId, vaultId);
    res.json(history.findByVault(req.userId, vaultId));
  } catch (e) { next(e); }
};

const allocate = (req, res, next) => {
  try {
    const vaultId = Number(req.params.id);
    const amountCents = parseAmount(req.body.amount);
    const vault = requireVault(req.userId, vaultId);

    if (amountCents > availableCents(req.userId)) {
      const e = new Error('Insufficient available balance: cannot allocate more than is spendable');
      e.status = 400; throw e;
    }

    history.add(req.userId, vaultId, 'allocate', amountCents);
    res.json(vaultView(req.userId, vault));
  } catch (e) { next(e); }
};

const withdraw = (req, res, next) => {
  try {
    const vaultId = Number(req.params.id);
    const amountCents = parseAmount(req.body.amount);
    const vault = requireVault(req.userId, vaultId);

    if (amountCents > vaultBalanceCents(req.userId, vaultId)) {
      const e = new Error('Cannot withdraw more than the vault balance');
      e.status = 400; throw e;
    }

    history.add(req.userId, vaultId, 'withdraw', amountCents);
    res.json(vaultView(req.userId, vault));
  } catch (e) { next(e); }
};

module.exports = { getHistory, allocate, withdraw };
