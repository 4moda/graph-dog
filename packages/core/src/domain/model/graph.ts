/**
 * Relation graph vocabulary.
 *
 * The graph answers "what else is connected to this evidence", so every edge
 * kind must be explainable in one phrase: an agent quoting a graph-reached hit
 * has to be able to say *why* it is relevant. Edges therefore come from
 * explicit structure (links, tags, directories) plus one similarity rule, never
 * from an opaque heuristic.
 */

export type EdgeKind = "links_to" | "linked_from" | "same_tag" | "same_directory" | "similar";

export type NodeKind = "document" | "tag" | "directory";

export interface GraphNode {
  readonly id: string;
  readonly kind: NodeKind;
  readonly label: string;
  /** The document ref for `document` nodes; null for tag and directory nodes. */
  readonly ref: string | null;
}

export interface GraphEdge {
  readonly src: string;
  readonly dst: string;
  readonly kind: EdgeKind;
  readonly weight: number;
}

/**
 * How much of a node's score survives one hop of each edge kind.
 *
 * Explicit authored links are trusted most: someone chose to point one document
 * at another. Sharing a directory is weakest, because co-location is usually an
 * accident of filing rather than a statement about meaning.
 */
export const EDGE_DECAY: Readonly<Record<EdgeKind, number>> = {
  links_to: 0.65,
  linked_from: 0.55,
  similar: 0.5,
  same_tag: 0.45,
  same_directory: 0.3,
};

/** Decay for an unknown edge kind, so a future edge cannot dominate by accident. */
export const UNKNOWN_EDGE_DECAY = 0.25;

export function decayFor(kind: string): number {
  return EDGE_DECAY[kind as EdgeKind] ?? UNKNOWN_EDGE_DECAY;
}

export function documentNodeId(ref: string): string {
  return `doc:${ref}`;
}

export function tagNodeId(tag: string): string {
  return `tag:${tag}`;
}

export function directoryNodeId(directory: string): string {
  return `dir:${directory}`;
}

/** Recover a document ref from a node id, or null if it is not a document node. */
export function refFromNodeId(nodeId: string): string | null {
  return nodeId.startsWith("doc:") ? nodeId.slice(4) : null;
}

/** One-phrase explanation of an edge, for human-facing output. */
export function describeEdge(kind: string): string {
  switch (kind) {
    case "links_to":
      return "links to";
    case "linked_from":
      return "is linked from";
    case "same_tag":
      return "shares a tag with";
    case "same_directory":
      return "sits beside";
    case "similar":
      return "is similar to";
    default:
      return `is related to (${kind})`;
  }
}
