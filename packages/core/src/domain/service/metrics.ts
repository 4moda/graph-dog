/**
 * Information-retrieval metrics.
 *
 * Pure arithmetic over a ranked list and a set of judgments. No IO, no corpus,
 * no notion of what a "hit" is beyond an id — which is what lets the whole
 * evaluation be tested against worked examples with known answers rather than
 * against whatever the search happens to return today.
 *
 * Why these four:
 *
 * - **Recall@K** answers "is the answer in there at all", which is the question
 *   that matters when an agent will read every result it is given.
 * - **MRR** answers "how far down", which is what determines whether an agent
 *   stops reading before it finds the answer.
 * - **nDCG@K** is the only one of the four that uses graded relevance, so it is
 *   the one that notices a merely-adjacent document outranking the real answer.
 * - **Evidence accuracy** is specific to this tool: a hit that names the right
 *   document but the wrong lines is a citation that does not check out, and no
 *   standard IR metric penalises it.
 */

/** A judged document: which ref, and how relevant. */
export interface Judgment {
  readonly ref: string;
  /**
   * Graded relevance. 0 is not relevant; higher is better. Ungraded judgments
   * default to 1, which makes the graded metrics degenerate to binary ones
   * rather than silently scoring everything as irrelevant.
   */
  readonly grade: number;
  /** Expected evidence span, when the dataset pins one. */
  readonly startLine?: number;
  readonly endLine?: number;
  /**
   * Expected page, for paginated sources such as PDF. When lines are pinned as
   * well they are read as lines within this page, as GraphDog reports them.
   */
  readonly page?: number;
}

/** One retrieved result, reduced to what the metrics need. */
export interface RetrievedItem {
  readonly ref: string;
  readonly startLine: number;
  readonly endLine: number;
  /** The page the chunk is on; null or absent for unpaginated sources. */
  readonly page?: number | null;
}

/** Judgments keyed by ref, for O(1) lookup during scoring. */
export function indexJudgments(judgments: readonly Judgment[]): Map<string, Judgment> {
  const index = new Map<string, Judgment>();
  for (const judgment of judgments) {
    const existing = index.get(judgment.ref);
    // A ref judged twice keeps the stronger grade: a dataset that lists a
    // document once per expected passage should not be scored as if the later
    // entry overrode the earlier one.
    if (existing === undefined || judgment.grade > existing.grade) index.set(judgment.ref, judgment);
  }
  return index;
}

function relevantRefs(judgments: ReadonlyMap<string, Judgment>): Set<string> {
  const refs = new Set<string>();
  for (const [ref, judgment] of judgments) {
    if (judgment.grade > 0) refs.add(ref);
  }
  return refs;
}

/**
 * Deduplicate a ranked list by ref, keeping the best-ranked occurrence.
 *
 * Search returns chunks, and several chunks of one document can appear in the
 * same result list. Metrics are about documents, so counting a document three
 * times would inflate precision and understate the cost of a near-miss.
 */
export function dedupeByRef(retrieved: readonly RetrievedItem[]): RetrievedItem[] {
  const seen = new Set<string>();
  const out: RetrievedItem[] = [];
  for (const item of retrieved) {
    if (seen.has(item.ref)) continue;
    seen.add(item.ref);
    out.push(item);
  }
  return out;
}

/**
 * Fraction of relevant documents that appear in the top `k`.
 *
 * A query with no relevant documents returns `null`, not 0 or 1: it is
 * unmeasurable, and averaging a fabricated value across a dataset would move
 * the headline number for no reason.
 */
export function recallAtK(
  retrieved: readonly RetrievedItem[],
  judgments: ReadonlyMap<string, Judgment>,
  k: number,
): number | null {
  const relevant = relevantRefs(judgments);
  if (relevant.size === 0) return null;
  const top = dedupeByRef(retrieved).slice(0, Math.max(0, k));
  let found = 0;
  for (const item of top) {
    if (relevant.has(item.ref)) found += 1;
  }
  return found / relevant.size;
}

/** Fraction of the top `k` results that are relevant. */
export function precisionAtK(
  retrieved: readonly RetrievedItem[],
  judgments: ReadonlyMap<string, Judgment>,
  k: number,
): number | null {
  const relevant = relevantRefs(judgments);
  if (relevant.size === 0) return null;
  const limit = Math.max(0, k);
  const top = dedupeByRef(retrieved).slice(0, limit);
  if (top.length === 0) return 0;
  let found = 0;
  for (const item of top) {
    if (relevant.has(item.ref)) found += 1;
  }
  // Divided by k rather than by the number returned, so a query that returns
  // two results and gets both right does not score the same as one that
  // returns ten and gets ten right.
  return found / limit;
}

/**
 * Reciprocal of the rank of the first relevant result; 0 when there is none.
 *
 * Averaged over a dataset this is MRR.
 */
export function reciprocalRank(
  retrieved: readonly RetrievedItem[],
  judgments: ReadonlyMap<string, Judgment>,
): number | null {
  const relevant = relevantRefs(judgments);
  if (relevant.size === 0) return null;
  const ranked = dedupeByRef(retrieved);
  for (let index = 0; index < ranked.length; index += 1) {
    const item = ranked[index];
    if (item !== undefined && relevant.has(item.ref)) return 1 / (index + 1);
  }
  return 0;
}

function discountedGain(grade: number, rank: number): number {
  // Standard formulation: exponential gain, logarithmic discount. The
  // exponential gain is what makes a grade-3 document at rank 2 outweigh a
  // grade-1 at rank 1, which is the judgment an evaluation should encode.
  return (2 ** grade - 1) / Math.log2(rank + 1);
}

/**
 * Normalized discounted cumulative gain over the top `k`.
 *
 * The ideal ranking is the judged documents sorted by grade, which means nDCG
 * is 1 only when the search returned the best available ordering.
 */
export function ndcgAtK(
  retrieved: readonly RetrievedItem[],
  judgments: ReadonlyMap<string, Judgment>,
  k: number,
): number | null {
  const grades = [...judgments.values()].map((judgment) => judgment.grade).filter((grade) => grade > 0);
  if (grades.length === 0) return null;

  const limit = Math.max(0, k);
  const top = dedupeByRef(retrieved).slice(0, limit);

  let dcg = 0;
  top.forEach((item, index) => {
    const grade = judgments.get(item.ref)?.grade ?? 0;
    if (grade > 0) dcg += discountedGain(grade, index + 1);
  });

  const ideal = [...grades].sort((left, right) => right - left).slice(0, limit);
  let idcg = 0;
  ideal.forEach((grade, index) => {
    idcg += discountedGain(grade, index + 1);
  });

  return idcg === 0 ? null : dcg / idcg;
}

/**
 * Whether a returned span overlaps the span the dataset expected.
 *
 * Overlap rather than exact equality: chunk boundaries are an implementation
 * detail that shifts when chunking parameters change, and demanding an exact
 * match would make the metric measure the chunker rather than the retrieval.
 * What matters is that a reader following the citation lands on the passage.
 */
export function spansOverlap(
  retrieved: { startLine: number; endLine: number },
  expected: { startLine: number; endLine: number },
): boolean {
  return retrieved.startLine <= expected.endLine && expected.startLine <= retrieved.endLine;
}

export interface EvidenceAccuracy {
  /** Judgments that pinned an expected span or page and whose document was retrieved. */
  readonly checked: number;
  /** Of those, how many landed on the right lines. */
  readonly correct: number;
  /** `correct / checked`, or null when the dataset pinned no spans. */
  readonly accuracy: number | null;
}

/**
 * How often a citation points at the right lines, not just the right file.
 *
 * Only judgments that pin a span are checked, and only when the document was
 * actually retrieved — a missed document is a recall failure and is already
 * counted as one. Double-counting it here would conflate two distinct problems.
 *
 * The consequence is that this figure is *conditional on retrieval* and is not
 * monotone with it: a change that improves recall brings previously unseen
 * documents under test, which can lower the ratio while raising the number of
 * correct citations. Read it beside `checked`, and gate on recall or MRR rather
 * than on this alone.
 */
export function evidenceAccuracy(
  retrieved: readonly RetrievedItem[],
  judgments: ReadonlyMap<string, Judgment>,
  k: number,
): EvidenceAccuracy {
  const top = dedupeByRef(retrieved).slice(0, Math.max(0, k));
  let checked = 0;
  let correct = 0;

  for (const item of top) {
    const judgment = judgments.get(item.ref);
    if (judgment === undefined || judgment.grade <= 0) continue;
    const pinsLines = judgment.startLine !== undefined && judgment.endLine !== undefined;
    const pinsPage = judgment.page !== undefined;
    if (!pinsLines && !pinsPage) continue;
    checked += 1;
    // A citation is right only if it lands where every pinned coordinate says:
    // the right page of a PDF, and the right lines when those are pinned too.
    const onPage = !pinsPage || item.page === judgment.page;
    const onLines =
      !pinsLines ||
      spansOverlap(item, { startLine: judgment.startLine as number, endLine: judgment.endLine as number });
    if (onPage && onLines) correct += 1;
  }

  return { checked, correct, accuracy: checked === 0 ? null : correct / checked };
}

/** Every metric for one query. `null` means "not measurable", never "zero". */
export interface QueryMetrics {
  readonly recallAtK: number | null;
  readonly precisionAtK: number | null;
  readonly reciprocalRank: number | null;
  readonly ndcgAtK: number | null;
  readonly evidence: EvidenceAccuracy;
  readonly retrieved: number;
  readonly relevant: number;
}

export function scoreQuery(
  retrieved: readonly RetrievedItem[],
  judgments: readonly Judgment[],
  k: number,
): QueryMetrics {
  const index = indexJudgments(judgments);
  return {
    recallAtK: recallAtK(retrieved, index, k),
    precisionAtK: precisionAtK(retrieved, index, k),
    reciprocalRank: reciprocalRank(retrieved, index),
    ndcgAtK: ndcgAtK(retrieved, index, k),
    evidence: evidenceAccuracy(retrieved, index, k),
    retrieved: dedupeByRef(retrieved).length,
    relevant: relevantRefs(index).size,
  };
}

/**
 * Mean of the measurable values, ignoring `null`.
 *
 * Returns `null` when nothing was measurable, rather than 0 — which would read
 * as "the search failed" when the truth is "the dataset did not ask".
 */
export function mean(values: ReadonlyArray<number | null>): number | null {
  const measurable = values.filter((value): value is number => value !== null);
  if (measurable.length === 0) return null;
  return measurable.reduce((sum, value) => sum + value, 0) / measurable.length;
}

/** The `p`-th percentile by nearest-rank, for latency reporting. */
export function percentile(values: readonly number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const rank = Math.ceil((p / 100) * sorted.length);
  const index = Math.min(sorted.length - 1, Math.max(0, rank - 1));
  return sorted[index] ?? null;
}

export interface AggregateMetrics {
  readonly queries: number;
  /** Queries the dataset could actually measure, i.e. that had judgments. */
  readonly measured: number;
  readonly recallAtK: number | null;
  readonly precisionAtK: number | null;
  /** Mean reciprocal rank. */
  readonly mrr: number | null;
  readonly ndcgAtK: number | null;
  readonly evidenceAccuracy: number | null;
  readonly evidenceChecked: number;
  /** Queries that returned nothing at all. */
  readonly zeroResultQueries: number;
  /** Queries where no relevant document was retrieved at any rank. */
  readonly missedQueries: number;
}

export function aggregate(perQuery: readonly QueryMetrics[]): AggregateMetrics {
  const evidenceChecked = perQuery.reduce((sum, metrics) => sum + metrics.evidence.checked, 0);
  const evidenceCorrect = perQuery.reduce((sum, metrics) => sum + metrics.evidence.correct, 0);

  return {
    queries: perQuery.length,
    measured: perQuery.filter((metrics) => metrics.relevant > 0).length,
    recallAtK: mean(perQuery.map((metrics) => metrics.recallAtK)),
    precisionAtK: mean(perQuery.map((metrics) => metrics.precisionAtK)),
    mrr: mean(perQuery.map((metrics) => metrics.reciprocalRank)),
    ndcgAtK: mean(perQuery.map((metrics) => metrics.ndcgAtK)),
    // Pooled over judgments rather than averaged per query, so a query with ten
    // checked spans weighs ten times a query with one. Averaging per query
    // would let a single-span query swing the figure.
    evidenceAccuracy: evidenceChecked === 0 ? null : evidenceCorrect / evidenceChecked,
    evidenceChecked,
    zeroResultQueries: perQuery.filter((metrics) => metrics.retrieved === 0).length,
    missedQueries: perQuery.filter((metrics) => metrics.reciprocalRank === 0).length,
  };
}
