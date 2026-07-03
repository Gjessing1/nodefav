/**
 * Fractional ordering keys (provisional scheme — revisited with rebalancing in
 * Phase 4). Keys are base-36 digit strings compared lexicographically, conceptually
 * the digits of a fraction in (0, 1). Two invariants keep midpoints well-defined:
 * keys are never empty and never end in '0', so between any two distinct keys —
 * and after any key — there is always room for another.
 */
const DIGITS = '0123456789abcdefghijklmnopqrstuvwxyz';

const VALID_KEY = /^[0-9a-z]*[1-9a-z]$/;

/**
 * A key strictly between `a` and `b`; `null` bounds mean the start/end of the
 * sequence. Throws if `a >= b` — callers with a possibly-inconsistent local
 * shadow should catch and fall back to an end key.
 */
export function keyBetween(a: string | null, b: string | null): string {
  const lo = a ?? '';
  const hi = b ?? '';
  if (lo !== '' && !VALID_KEY.test(lo)) throw new Error(`invalid order key "${lo}"`);
  if (hi !== '' && !VALID_KEY.test(hi)) throw new Error(`invalid order key "${hi}"`);
  if (hi !== '' && lo >= hi) throw new Error(`keyBetween: "${lo}" is not before "${hi}"`);
  return midpoint(lo, hi);
}

/** Midpoint of the open interval (a, b), where '' means 0 on the left and 1 on the right. */
function midpoint(a: string, b: string): string {
  if (b !== '') {
    // Shared prefix contributes nothing to the interval; recurse past it.
    let n = 0;
    while ((a.charAt(n) || DIGITS[0]) === b.charAt(n)) n += 1;
    if (n > 0) return b.slice(0, n) + midpoint(a.slice(n), b.slice(n));
  }
  const digitA = a === '' ? 0 : DIGITS.indexOf(a.charAt(0));
  const digitB = b === '' ? DIGITS.length : DIGITS.indexOf(b.charAt(0));
  if (digitB - digitA > 1) {
    return DIGITS.charAt(Math.round((digitA + digitB) / 2));
  }
  // First digits are consecutive: either b has more precision to truncate to,
  // or we descend into a's tail with an open right bound.
  if (b.length > 1) return b.slice(0, 1);
  return DIGITS.charAt(digitA) + midpoint(a.slice(1), '');
}
