'use strict';
/**
 * Unit — decimal ↔ cents conversion (src/lib/money.js).
 * The whole money convention rests on these two functions.
 */
const { toCents, toDecimal } = require('../../src/lib/money');

describe('money decimal↔cents', () => {
  it('converts decimals to integer cents', () => {
    expect(toCents(19.99)).toBe(1999);
    expect(toCents('10')).toBe(1000);
    expect(toCents(0)).toBe(0);
    expect(toCents(0.1 + 0.2)).toBe(30); // float noise is rounded away
  });

  it('converts cents back to decimals', () => {
    expect(toDecimal(1999)).toBe(19.99);
    expect(toDecimal(0)).toBe(0);
  });

  it('round-trips without drift', () => {
    expect(toDecimal(toCents(1234.56))).toBe(1234.56);
    expect(toDecimal(toCents(0.01))).toBe(0.01);
  });
});
