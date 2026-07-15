'use strict';
const { Entity: CategoriesEntity }   = require('./categories');
const { Entity: VaultsEntity }       = require('./vaults');
const { Entity: LoansEntity }        = require('./loans');
const { Entity: TransactionsEntity } = require('./transactions');
const { Entity: BalanceEntity }      = require('./balance');
const { Entity: TeamsEntity }        = require('./teams');
const { Entity: AuthEntity }         = require('./auth');
const { Entity: ShoppingListsEntity }     = require('./shopping-lists');
const { Entity: ShoppingListItemsEntity } = require('./shopping-list-items');
const { Entity: EventsEntity }            = require('./events');

module.exports = {
  CategoriesEntity, VaultsEntity, LoansEntity, TransactionsEntity, BalanceEntity, TeamsEntity, AuthEntity,
  ShoppingListsEntity, ShoppingListItemsEntity, EventsEntity,
};
