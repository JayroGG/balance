'use strict';
const db = require('../../../config/db');
const { modelGenerator } = require('../../../utils/modelGenerator');
const { fields } = require('./fields');
const { ENTITY_NAME } = require('../constants');

const base = modelGenerator(ENTITY_NAME, fields);

// Journal row for a loan movement (ADR-010): loan_id set, cents in, no hooks.
// Excluded from balance math; read-only via /transactions.
const createJournal = ({ userId, teamId }, { type, amountCents, description, loanId }) => {
  const { lastInsertRowid } = db.prepare(
    `INSERT INTO transactions (user_id, team_id, type, amount, description, loan_id) VALUES (?, ?, ?, ?, ?, ?)`
  ).run(userId, teamId ?? null, type, amountCents, description, loanId);
  return lastInsertRowid;
};

const TransactionModel = { ...base, createJournal };

module.exports = { TransactionModel };
