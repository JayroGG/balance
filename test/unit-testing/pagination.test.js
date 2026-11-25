'use strict';
const { positiveInt, parseLimit, encodeCursor, decodeCursor } = require('../../src/lib/pagination');

describe('pagination helper', () => {
  it('positiveInt accepts positive integers and passes undefined through', () => {
    expect(positiveInt(undefined, 'x')).toBeUndefined();
    expect(positiveInt('5', 'x')).toBe(5);
    for (const bad of ['0', '-1', '1.5', 'a', '']) expect(() => positiveInt(bad, 'x')).toThrow(/positive integer/);
  });

  it('parseLimit defaults and clamps', () => {
    expect(parseLimit(undefined, { def: 30, max: 100 })).toBe(30);
    expect(parseLimit('500', { def: 30, max: 100 })).toBe(100);
    expect(() => parseLimit('0', { def: 30, max: 100 })).toThrow();
  });

  it('cursor round-trips and rejects garbage with status 400', () => {
    expect(decodeCursor(encodeCursor(['2026-01-01', 7]))).toEqual(['2026-01-01', 7]);
    expect(decodeCursor(undefined)).toBeUndefined();
    expect(() => decodeCursor('%%%')).toThrow(expect.objectContaining({ status: 400 }));
    expect(() => decodeCursor(Buffer.from('{}').toString('base64url'))).toThrow();
  });
});
