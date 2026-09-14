/**
 * Search, plus the neighbourhood that connects the results.
 *
 * `explore` exists because an agent's second question is almost always "what
 * else is near this". Answering it in one call, with the nodes and edges made
 * explicit, is cheaper than a second round trip and more honest than quietly
 * widening `search` until unrelated documents appear in it.
 *
 * It is deliberately a thin wrapper: the ranking is the same pipeline with a
 * larger hop budget, so `search` and `explore` can never disagree about which
 * document is most relevant.
 */

import type { GraphEdge, GraphNode } from "../../domain/model/graph.ts";
import { searchCorpus, type SearchDependencies, type SearchOptions, type SearchOutcome } from "./search-corpus.ts";

export interface ExploreOptions extends SearchOptions {
  /** How many edges to include in the returned neighbourhood. */
  readonly neighborhoodLimit?: number;
}

export interface ExploreOutcome extends SearchOutcome {
  readonly nodes: GraphNode[];
  readonly edges: GraphEdge[];
}

export async function exploreCorpus(
  options: ExploreOptions,
  dependencies: SearchDependencies,
): Promise<ExploreOutcome> {
  const hops = options.hops ?? dependencies.config.search.exploreHops;
  const outcome = await searchCorpus({ ...options, hops }, dependencies);
  const { nodes, edges } = dependencies.store.graph.neighborhood(
    outcome.topRefs,
    options.neighborhoodLimit ?? 200,
  );
  return { ...outcome, nodes, edges };
}
