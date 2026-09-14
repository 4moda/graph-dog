/**
 * Deterministic string ordering.
 *
 * `String.prototype.localeCompare` is locale- and ICU-version-dependent: the
 * same two strings can order differently on two machines, or on the same
 * machine under a different `LANG`. GraphDog uses string order to break score
 * ties and to sequence stored rows, so that variance would make "the same
 * corpus and the same query give the same answer" quietly untrue across
 * machines -- exactly the property a portable corpus is supposed to have.
 *
 * Comparing UTF-16 code units is not linguistically correct ordering, and is
 * not meant to be. It is *stable*, which is what is actually required here.
 */

export function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** Descending by score, ties broken by ascending key. */
export function compareByScoreThenKey(
  left: readonly [string, number],
  right: readonly [string, number],
): number {
  return right[1] === left[1] ? compareStrings(left[0], right[0]) : right[1] - left[1];
}
