'use strict';
/**
 * Unit — normalizeColor (src/entities/teams/http/hooks.js).
 * Contract: '#'-optional, case-insensitive 6-digit hex in → '#RRGGBB'
 * uppercase out; null passes through (clears); anything else throws 400.
 */
const { normalizeColor } = require('../../src/entities/teams/http/hooks');

describe('normalizeColor', () => {
  it('normalizes valid hex input to #RRGGBB uppercase', () => {
    expect(normalizeColor('7c3aed')).toBe('#7C3AED');
    expect(normalizeColor('#dc2626')).toBe('#DC2626');
    expect(normalizeColor('#2563EB')).toBe('#2563EB');
  });

  it('passes null through (clears the color)', () => {
    expect(normalizeColor(null)).toBeNull();
  });

  it.each(['purple', '#ABC', '12345', '#1234567', 'GGGGGG', '', 123456, true, {}])(
    'rejects %p with a 400', (bad) => {
      let caught;
      try { normalizeColor(bad); } catch (e) { caught = e; }
      expect(caught).toBeDefined();
      expect(caught.status).toBe(400);
      expect(caught.message).toBe('color must be a hex color like #RRGGBB');
    });
});
