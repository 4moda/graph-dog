/**
 * Deriving the relation graph from indexed documents.
 *
 * Pure: it takes a description of the documents and a list of similarity pairs,
 * and returns nodes and edges. It never reads the store, so the whole rule set
 * is testable without a database.
 *
 * The graph is *derived* data and is rebuilt wholesale at the end of every
 * build. That costs one pass but removes orphan edges pointing at deleted
 * documents, which is the failure the predecessor's incremental GraphML
 * updates actually hit.
 */

import { refDirectory } from "../model/document.ts";
import {
  directoryNodeId,
  documentNodeId,
  tagNodeId,
  type GraphEdge,
  type GraphNode,
} from "../model/graph.ts";
import { LinkResolver } from "./link-resolver.ts";
import { compareStrings } from "../ordering.ts";

export interface GraphRules {
  readonly enableLinks: boolean;
  readonly enableTags: boolean;
  readonly enableDirectories: boolean;
  readonly enableSimilarity: boolean;
  /** Cosine below this is not a relationship, just noise. */
  readonly similarityThreshold: number;
  /**
   * A tag or directory shared by more documents than this is uninformative --
   * think a `docs/` folder or a `#draft` tag -- so it produces no edges.
   */
  readonly maxGroupSize: number;
}

export const DEFAULT_GRAPH_RULES: GraphRules = {
  enableLinks: true,
  enableTags: true,
  enableDirectories: true,
  enableSimilarity: true,
  similarityThreshold: 0.62,
  maxGroupSize: 40,
};

export interface GraphDocumentInput {
  readonly ref: string;
  readonly title: string;
  readonly tags: readonly string[];
  readonly links: readonly string[];
}

/** A document-level similarity, already collapsed from chunk neighbours. */
export interface SimilarityPair {
  readonly from: string;
  readonly to: string;
  readonly score: number;
}

export interface BuiltGraph {
  readonly nodes: GraphNode[];
  readonly edges: GraphEdge[];
}

export function buildGraph(
  documents: readonly GraphDocumentInput[],
  similarities: readonly SimilarityPair[],
  rules: GraphRules = DEFAULT_GRAPH_RULES,
): BuiltGraph {
  const nodes = new Map<string, GraphNode>();
  const edges = new Map<string, GraphEdge>();

  const addNode = (node: GraphNode): void => {
    if (!nodes.has(node.id)) nodes.set(node.id, node);
  };
  const addEdge = (edge: GraphEdge): void => {
    if (edge.src === edge.dst) return;
    const key = `${edge.src}\u0000${edge.dst}\u0000${edge.kind}`;
    const existing = edges.get(key);
    // Keep the strongest evidence when a pair is connected more than once.
    if (existing === undefined || edge.weight > existing.weight) edges.set(key, edge);
  };

  for (const document of documents) {
    addNode({
      id: documentNodeId(document.ref),
      kind: "document",
      label: document.title || document.ref,
      ref: document.ref,
    });
  }

  if (rules.enableLinks) addLinkEdges(documents, addEdge);
  if (rules.enableTags) addGroupEdges(documents, rules, "same_tag", addNode, addEdge);
  if (rules.enableDirectories) addGroupEdges(documents, rules, "same_directory", addNode, addEdge);
  if (rules.enableSimilarity) addSimilarityEdges(similarities, rules, addEdge);

  return {
    nodes: [...nodes.values()].sort((a, b) => compareStrings(a.id, b.id)),
    edges: [...edges.values()].sort(
      (a, b) => compareStrings(a.src, b.src) || compareStrings(a.dst, b.dst) || compareStrings(a.kind, b.kind),
    ),
  };
}

/** Authored links, resolved to documents in this corpus. */
function addLinkEdges(
  documents: readonly GraphDocumentInput[],
  addEdge: (edge: GraphEdge) => void,
): void {
  const resolver = new LinkResolver(documents.map((document) => document.ref));
  for (const document of documents) {
    for (const target of document.links) {
      const resolved = resolver.resolve(document.ref, target);
      if (resolved === null || resolved === document.ref) continue;
      addEdge({
        src: documentNodeId(document.ref),
        dst: documentNodeId(resolved),
        kind: "links_to",
        weight: 1,
      });
      // The reverse edge is weaker: being cited says less about a document than
      // its own choice of what to cite.
      addEdge({
        src: documentNodeId(resolved),
        dst: documentNodeId(document.ref),
        kind: "linked_from",
        weight: 0.8,
      });
    }
  }
}

/**
 * Tag and directory membership, via a shared waypoint node.
 *
 * Routing through one node keeps the edge count linear in group size rather
 * than quadratic: a tag on 30 documents costs 60 edges, not 870.
 */
function addGroupEdges(
  documents: readonly GraphDocumentInput[],
  rules: GraphRules,
  kind: "same_tag" | "same_directory",
  addNode: (node: GraphNode) => void,
  addEdge: (edge: GraphEdge) => void,
): void {
  const groups = new Map<string, string[]>();
  for (const document of documents) {
    const keys =
      kind === "same_tag" ? document.tags : [refDirectory(document.ref)].filter((d) => d !== "");
    for (const key of keys) {
      const bucket = groups.get(key);
      if (bucket) bucket.push(document.ref);
      else groups.set(key, [document.ref]);
    }
  }

  for (const [key, refs] of groups) {
    if (refs.length < 2 || refs.length > rules.maxGroupSize) continue;
    const nodeId = kind === "same_tag" ? tagNodeId(key) : directoryNodeId(key);
    addNode({
      id: nodeId,
      kind: kind === "same_tag" ? "tag" : "directory",
      label: key,
      ref: null,
    });
    // Weight is inverse to group size: a tag shared by three documents is a far
    // stronger claim of relatedness than one shared by thirty.
    const weight = 1 / refs.length;
    for (const ref of refs) {
      addEdge({ src: documentNodeId(ref), dst: nodeId, kind, weight });
      addEdge({ src: nodeId, dst: documentNodeId(ref), kind, weight });
    }
  }
}

function addSimilarityEdges(
  similarities: readonly SimilarityPair[],
  rules: GraphRules,
  addEdge: (edge: GraphEdge) => void,
): void {
  for (const pair of similarities) {
    if (pair.from === pair.to) continue;
    if (pair.score < rules.similarityThreshold) continue;
    addEdge({
      src: documentNodeId(pair.from),
      dst: documentNodeId(pair.to),
      kind: "similar",
      weight: pair.score,
    });
  }
}

/**
 * Collapse chunk-level nearest neighbours into document-level similarities.
 *
 * The best-scoring chunk pair wins, so a long document does not out-vote a
 * short one merely by having more chunks to contribute.
 */
export function collapseChunkNeighbors(
  neighbors: ReadonlyMap<string, ReadonlyArray<readonly [string, number]>>,
  chunkOwner: ReadonlyMap<string, string>,
): SimilarityPair[] {
  const best = new Map<string, SimilarityPair>();
  for (const [chunkId, hits] of neighbors) {
    const from = chunkOwner.get(chunkId);
    if (from === undefined) continue;
    for (const [otherChunkId, score] of hits) {
      const to = chunkOwner.get(otherChunkId);
      if (to === undefined || to === from) continue;
      const key = `${from}\u0000${to}`;
      const existing = best.get(key);
      if (existing === undefined || score > existing.score) best.set(key, { from, to, score });
    }
  }
  return [...best.values()].sort(
    (a, b) => compareStrings(a.from, b.from) || compareStrings(a.to, b.to),
  );
}
