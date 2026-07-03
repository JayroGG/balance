'use strict';
const { Entity: CategoriesEntity }   = require('./categories');
const { Entity: VaultsEntity }       = require('./vaults');
const { Entity: TransactionsEntity } = require('./transactions');
const { Entity: BalanceEntity }      = require('./balance');
const { Entity: TeamsEntity }        = require('./teams');
const { Entity: AuthEntity }         = require('./auth');
const { Entity: PaymentSourcesEntity } = require('./payment-sources');
const { Entity: SourceAliasesEntity }  = require('./source-aliases');

module.exports = {
  CategoriesEntity, VaultsEntity, TransactionsEntity, BalanceEntity, TeamsEntity, AuthEntity,
  PaymentSourcesEntity, SourceAliasesEntity,
};
