'use strict';
/** Unit — credit-card statement date math (ADR-014): cut/due days clamp to month length. */
const { lastCut, dueDate } = require('../../src/lib/cardCycle');

describe('lastCut', () => {
  it('is this month\'s cut when it has already passed (or is today)', () => {
    expect(lastCut('2026-11-20', 5)).toBe('2026-11-05');
    expect(lastCut('2026-11-05', 5)).toBe('2026-11-05');
  });

  it('is last month\'s cut when this month\'s is still ahead', () => {
    expect(lastCut('2026-11-04', 5)).toBe('2026-10-05');
    expect(lastCut('2026-01-02', 5)).toBe('2025-12-05'); // across the year
  });

  it('clamps day 31 to the last day of short months and leap Februaries', () => {
    expect(lastCut('2026-03-02', 31)).toBe('2026-02-28');
    expect(lastCut('2028-03-02', 31)).toBe('2028-02-29');
    expect(lastCut('2026-03-31', 31)).toBe('2026-03-31');
    expect(lastCut('2026-05-15', 31)).toBe('2026-04-30');
    expect(lastCut('2026-02-28', 31)).toBe('2026-02-28');
  });
});

describe('dueDate', () => {
  it('is the first due day strictly after the cut', () => {
    expect(dueDate('2026-11-05', 25)).toBe('2026-11-25'); // due later in the same month
    expect(dueDate('2026-11-25', 10)).toBe('2026-12-10'); // due earlier in the month -> next month
    expect(dueDate('2026-11-05', 5)).toBe('2026-12-05');  // same day is not "after"
    expect(dueDate('2026-12-20', 5)).toBe('2027-01-05');  // across the year
  });

  it('clamps the due day too', () => {
    expect(dueDate('2026-02-28', 10)).toBe('2026-03-10');
    expect(dueDate('2026-01-15', 31)).toBe('2026-01-31');
    expect(dueDate('2026-02-28', 31)).toBe('2026-03-31'); // Feb clamps to the 28th, not after the cut
    expect(dueDate('2026-01-31', 30)).toBe('2026-02-28');
  });
});
