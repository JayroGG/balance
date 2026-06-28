'use strict';
// eslint-disable-next-line no-unused-vars
module.exports = (err, req, res, next) => {
  const status = err.status || 500;
  const line = `${new Date().toISOString()} ${req.method} ${req.originalUrl} -> ${status}: ${err.message}`;
  // 5xx are bugs (log the stack); 4xx are expected client/validation failures.
  if (status >= 500) console.error(line, '\n', err.stack);
  else console.warn(line);
  res.status(status).json({ error: err.message || 'Internal server error' });
};
