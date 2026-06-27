'use strict';
const express = require('express');
const auth = require('./middleware/auth');
const errorHandler = require('./middleware/errorHandler');
const {
  CategoriesEntity,
  VaultsEntity,
  TransactionsEntity,
  BalanceEntity,
} = require('./entities');

const app = express();

app.use(express.json());
app.use((req, _res, next) => {
  console.log(`${new Date().toISOString()} ${req.method} ${req.url}`);
  next();
});
app.use(auth);

const routes = [
  { path: '/categories',   route: CategoriesEntity.routes },
  { path: '/vaults',       route: VaultsEntity.routes },
  { path: '/transactions', route: TransactionsEntity.routes },
  { path: '/balance',      route: BalanceEntity.routes },
];

routes.forEach(({ path, route }) => app.use(path, route));

app.use(errorHandler);

module.exports = app;
