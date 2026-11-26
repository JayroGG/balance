'use strict';
// Credit-card statement dates (ADR-014). Pure date math over 'YYYY-MM-DD' strings, UTC.
// A cut/due day past the end of a month clamps to that month's last day (day 31 in February -> 28/29).

const pad = (n) => String(n).padStart(2, '0');
const fmt = (y, m, d) => `${y}-${pad(m)}-${pad(d)}`;                 // m is 1-based
const daysIn = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();   // m is 1-based
const clamped = (y, m, day) => fmt(y, m, Math.min(day, daysIn(y, m)));
const shift = (y, m, by) => {                                         // month arithmetic, m is 1-based
  const idx = y * 12 + (m - 1) + by;
  return [Math.floor(idx / 12), (idx % 12) + 1];
};

const today = () => new Date().toISOString().slice(0, 10);

// Latest cut date <= todayStr.
const lastCut = (todayStr, cutDay) => {
  const y = +todayStr.slice(0, 4);
  const m = +todayStr.slice(5, 7);
  const here = clamped(y, m, cutDay);
  if (here <= todayStr) return here;
  const [py, pm] = shift(y, m, -1);
  return clamped(py, pm, cutDay);
};

// First due-day date strictly after the cut date. It is not rolled forward when passed: an
// unpaid statement keeps its (now overdue) due date until the next cut produces a new one.
const dueDate = (cutStr, dueDay) => {
  const y = +cutStr.slice(0, 4);
  const m = +cutStr.slice(5, 7);
  const here = clamped(y, m, dueDay);
  if (here > cutStr) return here;
  const [ny, nm] = shift(y, m, 1);
  return clamped(ny, nm, dueDay);
};

module.exports = { today, lastCut, dueDate };
