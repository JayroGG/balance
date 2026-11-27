'use strict';
const { Entity: CategoriesEntity }   = require('./categories');
const { Entity: VaultsEntity }       = require('./vaults');
const { Entity: LoansEntity }        = require('./loans');
const { Entity: CardsEntity }        = require('./cards');
const { Entity: TransactionsEntity } = require('./transactions');
const { Entity: BalanceEntity }      = require('./balance');
const { Entity: TeamsEntity }        = require('./teams');
const { Entity: AuthEntity }         = require('./auth');
const { Entity: ShoppingListsEntity }     = require('./shopping-lists');
const { Entity: ShoppingListItemsEntity } = require('./shopping-list-items');
const { Entity: EventsEntity }            = require('./events');
const { Entity: TransfersEntity }         = require('./transfers');
const { Entity: UsersEntity }             = require('./users');

module.exports = {
  CategoriesEntity, VaultsEntity, LoansEntity, CardsEntity, TransactionsEntity, BalanceEntity, TeamsEntity, AuthEntity,
  ShoppingListsEntity, ShoppingListItemsEntity, EventsEntity, TransfersEntity, UsersEntity,
};
