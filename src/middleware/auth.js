'use strict';
// POC auth stub (ADR-001): inject a fixed identity and a default personal context.
// Phase B replaces identity resolution here; the default-context line stays.
module.exports = (req, res, next) => {
  req.userId = 1;
  req.context = { userId: req.userId, teamId: null };
  next();
};
