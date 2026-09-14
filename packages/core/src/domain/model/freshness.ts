/**
 * Whether a corpus still reflects the sources it was built from.
 *
 * Staleness never blocks a search. Refusing to answer because an index is an
 * hour old is worse than answering with a flag, so this attaches a warning and
 * lets the caller weigh it.
 */

export type FreshnessStatus = "current" | "stale" | "unknown";

export interface Freshness {
  readonly status: FreshnessStatus;
  /** ISO-8601 timestamp of the last successful build, or null if never built. */
  readonly builtAt: string | null;
  /** Source id to the revision recorded at build time (null for unversioned sources). */
  readonly sourceRevisions: Readonly<Record<string, string | null>>;
  /** Why the status is what it is, when that is not obvious. */
  readonly reason: string | null;
}

export interface RevisionComparison {
  readonly sourceId: string;
  readonly indexedRevision: string | null;
  readonly currentRevision: string | null;
}

/**
 * Decide freshness by comparing indexed revisions against current ones.
 *
 * A source with no revision concept (a plain folder) cannot prove it is
 * current, so it yields `unknown` rather than a false `current`. Claiming
 * freshness we cannot verify is the failure mode worth avoiding here.
 */
export function assessFreshness(
  builtAt: string | null,
  comparisons: readonly RevisionComparison[],
): Freshness {
  const sourceRevisions: Record<string, string | null> = {};
  for (const comparison of comparisons) {
    sourceRevisions[comparison.sourceId] = comparison.indexedRevision;
  }

  if (builtAt === null) {
    return {
      status: "unknown",
      builtAt: null,
      sourceRevisions,
      reason: "corpus has never been built",
    };
  }

  const drifted = comparisons.filter(
    (c) =>
      c.indexedRevision !== null &&
      c.currentRevision !== null &&
      c.indexedRevision !== c.currentRevision,
  );
  if (drifted.length > 0) {
    const names = drifted.map((c) => c.sourceId).join(", ");
    return {
      status: "stale",
      builtAt,
      sourceRevisions,
      reason: `source revision changed since build: ${names}`,
    };
  }

  const unverifiable = comparisons.filter((c) => c.indexedRevision === null);
  if (unverifiable.length > 0) {
    const names = unverifiable.map((c) => c.sourceId).join(", ");
    return {
      status: "unknown",
      builtAt,
      sourceRevisions,
      reason: `no revision to compare for: ${names}; run 'graphdog update' to be sure`,
    };
  }

  return { status: "current", builtAt, sourceRevisions, reason: null };
}
