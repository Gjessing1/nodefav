/**
 * Fractional ordering keys. Keys are base-36 digit strings compared
 * lexicographically, conceptually the digits of a fraction in (0, 1). Two
 * invariants keep midpoints well-defined: keys are never empty and never end
 * in '0', so between any two distinct keys — and after any key — there is
 * always room for another. Repeated insertion into the same gap grows keys one
 * digit at a time; once a key would exceed MAX_KEY_LENGTH the parent's keys
 * are rebalanced with spreadKeys().
 */
const DIGITS = '0123456789abcdefghijklmnopqrstuvwxyz';

/** Keys longer than this trigger a sibling rebalance (precision exhaustion). */
export const MAX_KEY_LENGTH = 24;

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

/**
 * `count` short keys, evenly spread over (0, 1) and strictly increasing —
 * fresh assignments for every child of a rebalanced parent. Spacing leaves at
 * least one integer gap between neighbors, so post-rebalance midpoints stay
 * short.
 */
export function spreadKeys(count: number): string[] {
  if (count === 0) return [];
  // Smallest digit count whose key space leaves a gap of >= 2 between neighbors.
  let digits = 1;
  let space = DIGITS.length;
  while (space < 2 * (count + 1)) {
    digits += 1;
    space *= DIGITS.length;
  }
  const keys: string[] = [];
  for (let i = 1; i <= count; i += 1) {
    const value = Math.round((i * space) / (count + 1));
    // Fixed-width base-36, trailing zeros stripped: lexicographic order is
    // preserved (a stripped key is a prefix of its padded form) and no key
    // ends in '0'.
    keys.push(value.toString(36).padStart(digits, '0').replace(/0+$/, ''));
  }
  return keys;
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
