'use strict';
const express = require('express');
const auth = require('./middleware/auth');
const resolveContext = require('./middleware/resolveContext');
const errorHandler = require('./middleware/errorHandler');
const {
  CategoriesEntity,
  VaultsEntity,
  TransactionsEntity,
  BalanceEntity,
  TeamsEntity,
  AuthEntity,
} = require('./entities');

const app = express();

app.use(express.json());
// Log every request's outcome: method, url, status, and duration.
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    console.log(`${new Date().toISOString()} ${req.method} ${req.originalUrl} -> ${res.statusCode} ${Date.now() - start}ms`);
  });
  next();
});

// Public auth routes (login) must run BEFORE the identity middleware.
app.use('/auth', AuthEntity.publicRoutes);

app.use(auth);

// Protected auth routes (logout) need a validated token.
app.use('/auth', AuthEntity.protectedRoutes);

// `context: true` mounts resolveContext so ?team_id= switches the request context.
// Teams are managed via team_members, not context, so they opt out.
const routes = [
  { path: '/teams',        route: TeamsEntity.routes },
  { path: '/categories',   route: CategoriesEntity.routes,   context: true },
  { path: '/vaults',       route: VaultsEntity.routes,       context: true },
  { path: '/transactions', route: TransactionsEntity.routes, context: true },
  { path: '/balance',      route: BalanceEntity.routes,      context: true },
];

routes.forEach(({ path, route, context }) =>
  context ? app.use(path, resolveContext, route) : app.use(path, route));

app.use(errorHandler);

module.exports = app;
