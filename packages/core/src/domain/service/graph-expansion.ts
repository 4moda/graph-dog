/**
 * Walking outward from seed documents, decaying score at each hop.
 *
 * Expansion answers "what else is connected to this evidence". Two properties
 * matter more than raw recall:
 *
 * - **Determinism.** The predecessor sampled random node pairs once a graph
 *   passed 500 nodes, so two builds of the same corpus produced different
 *   graphs and different answers. Nothing here is sampled or randomized.
 * - **Explainability.** Every reached document carries the chain of edges that
 *   reached it, so a hit can show *how* it is related rather than asserting
 *   that it is.
 *
 * Adjacency is supplied by a callback so this stays pure domain logic and never
 * knows that the graph lives in SQLite.
 */

import { decayFor, refFromNodeId, type GraphEdge } from "../model/graph.ts";
import { compareStrings } from "../ordering.ts";

/** Returns every outgoing edge from the given nodes. Supplied by the caller. */
export type NeighborLookup = (nodeIds: readonly string[]) => readonly GraphEdge[];

export interface ExpansionConfig {
  readonly hops: number;
  readonly maxNodes: number;
  /** Scores below this are not worth a hop; keeps expansion from flooding. */
  readonly minScore: number;
}

export const DEFAULT_EXPANSION: ExpansionConfig = { hops: 2, maxNodes: 64, minScore: 0.01 };

export interface ExpansionResult {
  /** Document ref to its graph-proximity score. Seeds are excluded. */
  readonly scores: Map<string, number>;
  /** Document ref to the best edge chain that reached it. */
  readonly paths: Map<string, GraphEdge[]>;
}

/**
 * Expand from `seeds` (node id to starting score).
 *
 * Score decays by edge kind and by edge weight at every hop, so a document
 * three weak hops away cannot outrank a direct match. The square root on
 * weight softens the penalty for edges whose weight is an inverse group size,
 * which would otherwise make any tag shared by more than a handful of
 * documents contribute nothing at all.
 */
export function expandGraph(
  seeds: ReadonlyMap<string, number>,
  neighbors: NeighborLookup,
  config: ExpansionConfig = DEFAULT_EXPANSION,
): ExpansionResult {
  const empty: ExpansionResult = { scores: new Map(), paths: new Map() };
  if (seeds.size === 0 || config.hops <= 0) return empty;

  const scores = new Map<string, number>(seeds);
  const paths = new Map<string, GraphEdge[]>();
  for (const nodeId of seeds.keys()) paths.set(nodeId, []);

  let frontier = [...seeds.keys()];
  const visited = new Set(frontier);

  for (let hop = 0; hop < config.hops && frontier.length > 0; hop += 1) {
    const next: string[] = [];
    // Sorting keeps the traversal order fixed regardless of Map insertion order.
    const edges = [...neighbors(frontier)].sort(compareEdges);
    for (const edge of edges) {
      const from = scores.get(edge.src);
      if (from === undefined) continue;
      const candidate = from * decayFor(edge.kind) * Math.sqrt(Math.max(edge.weight, 0));
      if (candidate < config.minScore) continue;
      if (candidate > (scores.get(edge.dst) ?? 0)) {
        scores.set(edge.dst, candidate);
        paths.set(edge.dst, [...(paths.get(edge.src) ?? []), edge]);
        if (!visited.has(edge.dst)) {
          visited.add(edge.dst);
          next.push(edge.dst);
        }
      }
    }
    frontier = next;
  }

  const reachedScores = new Map<string, number>();
  const reachedPaths = new Map<string, GraphEdge[]>();
  for (const [nodeId, score] of scores) {
    if (seeds.has(nodeId)) continue;
    const ref = refFromNodeId(nodeId);
    if (ref === null) continue; // tag and directory nodes are waypoints, not results
    reachedScores.set(ref, score);
    reachedPaths.set(ref, paths.get(nodeId) ?? []);
  }

  const top = [...reachedScores.entries()]
    .sort((left, right) =>
      right[1] === left[1] ? compareStrings(left[0], right[0]) : right[1] - left[1],
    )
    .slice(0, config.maxNodes);

  return {
    scores: new Map(top),
    paths: new Map(top.map(([ref]) => [ref, reachedPaths.get(ref) ?? []])),
  };
}

function compareEdges(left: GraphEdge, right: GraphEdge): number {
  return (
    compareStrings(left.src, right.src) ||
    compareStrings(left.dst, right.dst) ||
    compareStrings(left.kind, right.kind)
  );
}
