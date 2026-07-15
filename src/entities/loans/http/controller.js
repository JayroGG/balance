'use strict';
const db = require('../../../config/db');
const { LoanModel } = require('../db/model');
const history = require('../db/history');
const { toCents, toDecimal } = require('../../../lib/money');
// Import balance queries directly to avoid circular index deps
const { availableCents, loanPendingCents } = require('../../balance/db/queries');
const { assertCanWrite, assertCanMutate } = require('../../../lib/access');
const { EventModel } = require('../../events/db/model');
// Cross-entity model imported directly to avoid circular index deps.
const { TransactionModel } = require('../../transactions/db/model');

const ACTION_EVENTS = { lend: 'lent', repay: 'repaid' };

// Loan record + its derived amount/pending (the shape the mobile client consumes).
const loanView = (loan) => {
  const figures = history.figures(loan.id);
  return {
    id:      loan.id,
    name:    loan.name,
    amount:  toDecimal(figures.amountCents),
    pending: toDecimal(figures.pendingCents),
  };
};

// Resolve { amount } from the body into positive cents, or throw 400.
const parseAmount = (raw) => {
  if (raw === undefined || raw === null) { const e = new Error('Missing required field: amount'); e.status = 400; throw e; }
  const cents = toCents(raw);
  if (!Number.isInteger(cents) || cents <= 0) { const e = new Error('amount must be a positive number'); e.status = 400; throw e; }
  return cents;
};

const requireLoan = (scope, loanId) => {
  const loan = LoanModel.findById(scope, loanId);
  if (!loan) { const e = new Error('Loan not found'); e.status = 404; throw e; }
  return loan;
};

// Journal rows and bound checks run in the LOAN's own context (checkout precedent),
// not the caller's active one, so a shared loan always posts against its own ledger.
const loanScope = (loan, req) => ({
  userId:  loan.user_id,
  teamId:  loan.team_id ?? null,
  isAdmin: req.context.isAdmin,
});

// Atomic: create the loan, optionally post a counted opening income (pre_existing),
// append the lend movement, and post its journal expense. Either all land or none
// do. The opening income runs BEFORE the lend movement so intermediate state never
// has available < 0.
const commitCreate = db.transaction((ctxScope, actorId, { name, amount, cents, preExisting }) => {
  const loan = LoanModel.create(ctxScope, { name });
  const scope = loanScope(loan, { context: ctxScope });

  if (preExisting) {
    TransactionModel.create(scope, { type: 'income', amount, description: `Loan opening: ${name}` });
  }
  history.add(actorId, loan.id, 'lend', cents);
  TransactionModel.createJournal(scope, { type: 'expense', amountCents: cents, description: loan.name, loanId: loan.id });

  EventModel.log({ userId: actorId, teamId: loan.team_id ?? null,
    entity: 'loan', entityId: loan.id, action: 'created', summary: { name: loan.name, amount: toDecimal(cents) } });
  return loan;
});

// Atomic: append the lend/repay movement and its journal row, and log the event.
const commitMovement = db.transaction((scope, actorId, loan, action, journalType, cents) => {
  history.add(actorId, loan.id, action, cents);
  TransactionModel.createJournal(scope, { type: journalType, amountCents: cents, description: loan.name, loanId: loan.id });
  EventModel.log({ userId: actorId, teamId: loan.team_id ?? null,
    entity: 'loan', entityId: loan.id, action: ACTION_EVENTS[action],
    summary: { name: loan.name, amount: toDecimal(cents) } });
});

// Custom POST / (shadows the generated createHandler — see http/routes.js), so
// the guest gate is asserted here; the generated CREATE after-hook never fires.
const create = (req, res, next) => {
  try {
    assertCanWrite(req.context);
    const { name, amount, pre_existing } = req.body;
    if (!name) { const e = new Error('Missing required field: name'); e.status = 400; throw e; }

    if (amount === undefined || amount === null) {
      const loan = LoanModel.create(req.context, { name });
      EventModel.log({ userId: req.userId, teamId: loan.team_id ?? null,
        entity: 'loan', entityId: loan.id, action: 'created', summary: { name: loan.name } });
      return res.status(201).json(loanView(loan));
    }

    const cents = parseAmount(amount);
    if (!pre_existing && cents > availableCents(req.context)) {
      const e = new Error('Insufficient available balance: cannot lend more than is spendable');
      e.status = 400; throw e;
    }

    const loan = commitCreate(req.context, req.userId, { name, amount, cents, preExisting: !!pre_existing });
    res.status(201).json(loanView(loan));
  } catch (e) { next(e); }
};

const lend = (req, res, next) => {
  try {
    const loanId = Number(req.params.id);
    const cents = parseAmount(req.body.amount);
    const loan = requireLoan(req.context, loanId);
    assertCanMutate(req.context, loan);

    const scope = loanScope(loan, req);
    if (cents > availableCents(scope)) {
      const e = new Error('Insufficient available balance: cannot lend more than is spendable');
      e.status = 400; throw e;
    }

    commitMovement(scope, req.userId, loan, 'lend', 'expense', cents);
    res.json(loanView(loan));
  } catch (e) { next(e); }
};

const repay = (req, res, next) => {
  try {
    const loanId = Number(req.params.id);
    const cents = parseAmount(req.body.amount);
    const loan = requireLoan(req.context, loanId);
    assertCanMutate(req.context, loan);

    const scope = loanScope(loan, req);
    if (cents > loanPendingCents(scope, loanId)) {
      const e = new Error('Cannot repay more than the loan pending amount');
      e.status = 400; throw e;
    }

    commitMovement(scope, req.userId, loan, 'repay', 'income', cents);
    res.json(loanView(loan));
  } catch (e) { next(e); }
};

const getHistory = (req, res, next) => {
  try {
    const loanId = Number(req.params.id);
    requireLoan(req.context, loanId);
    res.json(history.findByLoan(loanId));
  } catch (e) { next(e); }
};

module.exports = { create, lend, repay, getHistory };
