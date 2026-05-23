'use strict';
const { BEFORE_CREATE, BEFORE_UPDATE } = require('../../../constants/hooks');
// Import vaults model directly to avoid circular index deps
const { VaultModel } = require('../../vaults/db/model');

const VALID_TYPES = ['income', 'expense'];

const assertType = (type) => {
  if (type !== undefined && !VALID_TYPES.includes(type)) {
    const e = new Error('type must be income or expense'); e.status = 400; throw e;
  }
};

const assertVaultAllowed = (userId, type, vaultId) => {
  if (type === 'expense' && vaultId) {
    const e = new Error('Expense transactions cannot be assigned to a vault'); e.status = 400; throw e;
  }
  if (vaultId) {
    const vault = VaultModel.findById(userId, Number(vaultId));
    if (!vault) { const e = new Error('Vault not found'); e.status = 404; throw e; }
  }
};

const transactionHooks = ({ type, body, previous, req }) => {
  switch (type) {
    case BEFORE_CREATE:
      if (!body.type)   { const e = new Error('Missing required field: type');   e.status = 400; throw e; }
      if (!body.amount) { const e = new Error('Missing required field: amount'); e.status = 400; throw e; }
      assertType(body.type);
      assertVaultAllowed(req.userId, body.type, body.vault_id);
      return;

    case BEFORE_UPDATE: {
      const resolvedType    = body.type     !== undefined ? body.type     : previous.type;
      const resolvedVaultId = body.vault_id !== undefined ? body.vault_id : previous.vault_id;
      assertType(resolvedType);
      assertVaultAllowed(req.userId, resolvedType, resolvedVaultId);
      return;
    }

    default:
      return;
  }
};

module.exports = { transactionHooks };
