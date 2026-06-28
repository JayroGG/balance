'use strict';
const { Entity: CategoriesEntity }   = require('./categories');
const { Entity: VaultsEntity }       = require('./vaults');
const { Entity: TransactionsEntity } = require('./transactions');
const { Entity: BalanceEntity }      = require('./balance');
const { Entity: TeamsEntity }        = require('./teams');

module.exports = { CategoriesEntity, VaultsEntity, TransactionsEntity, BalanceEntity, TeamsEntity };
