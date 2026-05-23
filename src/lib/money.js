'use strict';

const toCents = (decimal) => Math.round(Number(decimal) * 100);
const toDecimal = (cents) => cents / 100;

module.exports = { toCents, toDecimal };
