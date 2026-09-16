/**
 * Keeping the chunk similarity lists current without recomputing them all.
 *
 * Similarity edges come from each chunk's nearest neighbours, and computing
 * those is quadratic: on a 5,000-document corpus it is 140 of the 145 seconds
 * an update takes, whether or not anything changed. That cost is what makes a
 * file-watcher or a commit hook unaffordable.
 *
 * The lists are therefore stored, and an update touches only what the change
 * can have reached. Three groups, given the chunks that went (`removed`) and
 * the chunks that arrived:
 *
 * - **Arrivals** have no list. Computed against the whole corpus.
 * - **Survivors whose stored list named a removed chunk** have a hole in it,
 *   and what fills the hole may be a chunk the list never mentioned. Computed
 *   against the whole corpus.
 * - **Every other survivor** keeps a list that is still exactly its top-K over
 *   the chunks that remain, because dropping non-members changes nothing. Its
 *   new top-K can only be drawn from that list plus the arrivals, so scoring it
 *   against the arrivals alone is enough.
 *
 * The third group is the corpus, and it costs one pass over the arrivals rather
 * than one over everything. The result is identical to a rebuild's -- not
 * approximately, exactly -- which the build specs assert directly.
 */

import { compareStrings } from "../ordering.ts";

/** How many neighbours each chunk keeps. Their document pairs become `similar` edges. */
export const SIMILARITY_NEIGHBORS = 5;

/** A chunk's nearest others, strongest first. */
export type NeighborList = ReadonlyArray<readonly [string, number]>;

/**
 * Strongest first, ties broken on chunk id.
 *
 * The same order the vector index returns, and it has to be: a merged list and
 * a recomputed one must agree down to which of two equal scores comes first.
 */
export function compareNeighbors(
  left: readonly [string, number],
  right: readonly [string, number],
): number {
  return right[1] === left[1] ? compareStrings(left[0], right[0]) : right[1] - left[1];
}

export interface RefreshPlan {
  /** Chunks needing a full scan of the corpus. */
  readonly recompute: string[];
  /** Chunks whose stored list only needs the arrivals merged into it. */
  readonly merge: string[];
}

/**
 * Split the surviving chunks by how much work their list needs.
 *
 * A survivor with no stored list is recomputed: absence means the corpus was
 * built before the lists were kept, or by a build that had similarity off.
 */
export function planNeighborRefresh(
  survivors: readonly string[],
  removed: ReadonlySet<string>,
  stored: ReadonlyMap<string, NeighborList>,
): RefreshPlan {
  const recompute: string[] = [];
  const merge: string[] = [];
  for (const chunkId of survivors) {
    const list = stored.get(chunkId);
    if (list === undefined) recompute.push(chunkId);
    else if (list.some(([other]) => removed.has(other))) recompute.push(chunkId);
    else merge.push(chunkId);
  }
  return { recompute, merge };
}

/**
 * Merge arrivals into a stored list, or report that they change nothing.
 *
 * `stored` must already be free of removed chunks -- `planNeighborRefresh`
 * sends any list that is not to a full recompute, precisely so this does not
 * have to guess what would have filled the hole.
 *
 * Returns `null` when the list is unchanged, so an update writes only the rows
 * a rebuild would have written differently.
 */
export function mergeNeighbors(
  stored: NeighborList,
  arrivals: NeighborList,
  topK: number,
): Array<[string, number]> | null {
  if (arrivals.length === 0) return null;

  const best = new Map<string, number>(stored.map(([id, score]) => [id, score]));
  for (const [id, score] of arrivals) {
    const existing = best.get(id);
    if (existing === undefined || score > existing) best.set(id, score);
  }

  const merged = [...best.entries()]
    .map(([id, score]): [string, number] => [id, score])
    .sort(compareNeighbors)
    .slice(0, topK);

  if (merged.length === stored.length) {
    const same = merged.every((entry, index) => {
      const before = stored[index];
      return before !== undefined && before[0] === entry[0] && before[1] === entry[1];
    });
    if (same) return null;
  }
  return merged;
}

/**
 * What the stored lists were produced by.
 *
 * Compared before any of them is trusted. A different embedding model, a
 * different neighbour count or a chunk count that does not match the corpus
 * means something wrote chunks without maintaining the lists -- an older
 * GraphDog, or a build with similarity switched off -- and the only safe
 * reading of the stored rows is that there are none.
 */
export function neighborStamp(embeddingId: string, topK: number, chunkCount: number): string {
  return `${embeddingId}|${topK}|${chunkCount}`;
}
