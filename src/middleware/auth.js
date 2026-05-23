'use strict';
module.exports = (req, res, next) => {
  req.userId = 1;
  next();
};
