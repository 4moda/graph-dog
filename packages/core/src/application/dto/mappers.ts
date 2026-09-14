/**
 * Domain objects to wire DTOs.
 *
 * Every interface serializes through these functions and no other path, which
 * is what makes the CLI and the MCP server byte-identical rather than
 * approximately similar. Key insertion order here *is* the documented key order
 * of the JSON.
 */

import type { Location } from "../../domain/model/location.ts";
import { formatLocation } from "../../domain/model/location.ts";
import type { Freshness } from "../../domain/model/freshness.ts";
import type { GraphEdge, GraphNode } from "../../domain/model/graph.ts";
import { describeEdge } from "../../domain/model/graph.ts";
import type { Scores } from "../../domain/model/scores.ts";
import { dominantSignal } from "../../domain/model/scores.ts";
import type {
  FreshnessDto,
  GraphEdgeDto,
  GraphNodeDto,
  HitDto,
  LocationDto,
  ScoresDto,
  WarningDto,
} from "./contracts.ts";
import { round } from "./contracts.ts";

export interface Warning {
  readonly code: string;
  readonly message: string;
  readonly details?: Record<string, unknown>;
}

/** A retrieved chunk, assembled by the query pipeline. */
export interface HitView {
  readonly corpus: string;
  readonly ref: string;
  readonly chunkId: string;
  readonly title: string;
  readonly headingPath: string;
  readonly snippet: string;
  readonly location: Location;
  readonly scores: Scores;
  readonly sourceRevision: string | null;
  readonly graphPath: readonly GraphEdge[];
  readonly tags: readonly string[];
  /** 1-based rank within its own corpus. */
  readonly corpusRank: number;
}

export function toLocationDto(location: Location): LocationDto {
  const base = {
    start_line: location.startLine,
    end_line: location.endLine,
    start_char: location.startChar,
    end_char: location.endChar,
  };
  // `page` is omitted rather than null for unpaginated sources: its presence is
  // the signal that line numbers are page-relative.
  return location.page === null ? base : { ...base, page: location.page };
}

export function toScoresDto(scores: Scores): ScoresDto {
  return {
    dense: round(scores.dense),
    bm25: round(scores.bm25),
    graph: round(scores.graph),
    rerank: round(scores.rerank),
    final: round(scores.final) ?? 0,
  };
}

export function toEdgeDto(edge: GraphEdge): GraphEdgeDto {
  return {
    src: edge.src,
    dst: edge.dst,
    kind: edge.kind,
    weight: round(edge.weight) ?? 0,
    relation: describeEdge(edge.kind),
  };
}

export function toNodeDto(node: GraphNode): GraphNodeDto {
  return { id: node.id, kind: node.kind, label: node.label, ref: node.ref };
}

export function toHitDto(hit: HitView): HitDto {
  return {
    corpus: hit.corpus,
    ref: hit.ref,
    chunk_id: hit.chunkId,
    title: hit.title,
    heading_path: hit.headingPath,
    snippet: hit.snippet,
    location: toLocationDto(hit.location),
    scores: toScoresDto(hit.scores),
    found_by: hit.graphPath.length > 0 ? "graph" : dominantSignal(hit.scores),
    graph_path: hit.graphPath.map(toEdgeDto),
    source_revision: hit.sourceRevision,
    tags: [...hit.tags],
    read_ref: `${hit.ref}${formatLocation(hit.location)}`,
    corpus_rank: hit.corpusRank,
  };
}

export function toFreshnessDto(freshness: Freshness): FreshnessDto {
  return {
    status: freshness.status,
    built_at: freshness.builtAt,
    source_revisions: { ...freshness.sourceRevisions },
    reason: freshness.reason,
  };
}

export function toWarningDto(warning: Warning): WarningDto {
  return { code: warning.code, message: warning.message, details: warning.details ?? {} };
}

export function toWarningDtos(warnings: readonly Warning[]): WarningDto[] {
  return warnings.map(toWarningDto);
}
