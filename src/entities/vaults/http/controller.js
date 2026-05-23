'use strict';
const { VaultModel } = require('../db/model');
const history = require('../db/history');
// Import transactions model directly to avoid circular index deps
const { TransactionModel } = require('../../transactions/db/model');

const getHistory = (req, res, next) => {
  try {
    const vaultId = Number(req.params.id);
    const vault = VaultModel.findById(req.userId, vaultId);
    if (!vault) { const e = new Error('Vault not found'); e.status = 404; throw e; }
    res.json(history.findByVault(req.userId, vaultId));
  } catch (e) { next(e); }
};

const allocate = (req, res, next) => {
  try {
    const vaultId = Number(req.params.id);
    const transactionId = Number(req.body.transaction_id);

    if (!transactionId) { const e = new Error('Missing required field: transaction_id'); e.status = 400; throw e; }

    const vault = VaultModel.findById(req.userId, vaultId);
    if (!vault) { const e = new Error('Vault not found'); e.status = 404; throw e; }

    const txn = TransactionModel.findByIdRaw(req.userId, transactionId);
    if (!txn) { const e = new Error('Transaction not found'); e.status = 404; throw e; }
    if (txn.type !== 'income') {
      const e = new Error('Only income transactions can be allocated to a vault');
      e.status = 400; throw e;
    }

    // If moving from another vault, log a withdraw from the old vault first
    if (txn.vault_id && txn.vault_id !== vaultId) {
      history.add(req.userId, txn.vault_id, transactionId, 'withdraw', txn.amount);
    }

    TransactionModel.setVaultId(req.userId, transactionId, vaultId);
    history.add(req.userId, vaultId, transactionId, 'allocate', txn.amount);

    res.json(VaultModel.findById(req.userId, vaultId));
  } catch (e) { next(e); }
};

const withdraw = (req, res, next) => {
  try {
    const vaultId = Number(req.params.id);
    const transactionId = Number(req.body.transaction_id);

    if (!transactionId) { const e = new Error('Missing required field: transaction_id'); e.status = 400; throw e; }

    const vault = VaultModel.findById(req.userId, vaultId);
    if (!vault) { const e = new Error('Vault not found'); e.status = 404; throw e; }

    const txn = TransactionModel.findByIdRaw(req.userId, transactionId);
    if (!txn) { const e = new Error('Transaction not found'); e.status = 404; throw e; }
    if (txn.vault_id !== vaultId) {
      const e = new Error('Transaction is not allocated to this vault');
      e.status = 400; throw e;
    }

    TransactionModel.setVaultId(req.userId, transactionId, null);
    history.add(req.userId, vaultId, transactionId, 'withdraw', txn.amount);

    res.json(VaultModel.findById(req.userId, vaultId));
  } catch (e) { next(e); }
};

module.exports = { getHistory, allocate, withdraw };
