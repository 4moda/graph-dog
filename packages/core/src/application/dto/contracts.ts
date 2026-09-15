/**
 * The wire contract: every shape an agent parses.
 *
 * This module is the single definition of GraphDog's public output. The CLI's
 * `--json` mode and the MCP tool results both serialize these exact objects
 * through the mappers in `mappers.ts`, which is how CLI/MCP equivalence is
 * *enforced* rather than merely documented -- there is no second code path that
 * could drift.
 *
 * Field names are snake_case because these are JSON documents read by other
 * tools, not JavaScript values. Key order and numeric rounding are part of the
 * contract and are pinned by golden tests, so two runs diff cleanly.
 */

import { CHUNKING_SCHEMA_VERSION, SCHEMA_VERSION } from "../../domain/model/corpus-identity.ts";

/**
 * Shape of the response bodies. Bumped when an observable shape changes.
 *
 * 1.1 added `corpus` and `corpus_rank` to hits, `corpora` to search responses,
 * and the `evaluation_report` kind. 1.2 emits `archive_report` for `export`
 * and `import`, with `destination` and `manifest`. All additive.
 */
export const CONTRACT_VERSION = "1.2";

export { CHUNKING_SCHEMA_VERSION, SCHEMA_VERSION };

/** Every response carries these, so a consumer can gate on them before parsing. */
export interface ResponseEnvelope {
  readonly schema_version: string;
  readonly contract_version: string;
  readonly kind: string;
}

export interface LocationDto {
  readonly start_line: number;
  readonly end_line: number;
  readonly start_char: number;
  readonly end_char: number;
  readonly page?: number;
}

export interface ScoresDto {
  readonly dense: number | null;
  readonly bm25: number | null;
  readonly graph: number | null;
  readonly rerank: number | null;
  readonly final: number;
}

export interface GraphEdgeDto {
  readonly src: string;
  readonly dst: string;
  readonly kind: string;
  readonly weight: number;
  /** Human-readable phrasing of `kind`, so output needs no lookup table. */
  readonly relation: string;
}

export interface GraphNodeDto {
  readonly id: string;
  readonly kind: string;
  readonly label: string;
  readonly ref: string | null;
}

export interface HitDto {
  /** Which corpus this hit came from. Always present, even for one corpus. */
  readonly corpus: string;
  readonly ref: string;
  readonly chunk_id: string;
  readonly title: string;
  readonly heading_path: string;
  readonly snippet: string;
  readonly location: LocationDto;
  readonly scores: ScoresDto;
  /** Which signal is most responsible for this hit: dense, bm25, graph or none. */
  readonly found_by: string;
  /** The edge chain that reached this hit; empty when it was matched directly. */
  readonly graph_path: readonly GraphEdgeDto[];
  readonly source_revision: string | null;
  readonly tags: readonly string[];
  /** Ready-to-use argument for `graphdog read`, e.g. `docs/a.md#L10-L24`. */
  readonly read_ref: string;
  /**
   * 1-based rank of this hit within its own corpus.
   *
   * When several corpora are searched, `scores.final` is the cross-corpus fused
   * score and this is what it was fused from. Keeping both means a caller can
   * see that a hit ranked first in a small corpus without inferring it.
   */
  readonly corpus_rank: number;
}

/** What one corpus contributed to a search. */
export interface CorpusSearchSummaryDto {
  readonly name: string;
  readonly scope: string;
  /** Which embedding produced its vectors; differing values are flagged. */
  readonly embedding_id: string | null;
  /** How many of the returned hits came from this corpus. */
  readonly hits: number;
  /** False when the corpus was skipped; `skipped_reason` then says why. */
  readonly searched: boolean;
  readonly skipped_reason: string | null;
}

export interface FreshnessDto {
  readonly status: "current" | "stale" | "unknown";
  readonly built_at: string | null;
  readonly source_revisions: Readonly<Record<string, string | null>>;
  readonly reason: string | null;
}

export interface WarningDto {
  readonly code: string;
  readonly message: string;
  readonly details: Readonly<Record<string, unknown>>;
}

export interface SearchResponseDto extends ResponseEnvelope {
  readonly kind: "search";
  readonly query: string;
  /**
   * The corpus searched, or a comma-separated list when several were.
   *
   * `corpora` is authoritative; this field is for display and for consumers
   * written against the single-corpus shape.
   */
  readonly corpus: string;
  /** One entry per corpus considered, including any that were skipped. */
  readonly corpora: readonly CorpusSearchSummaryDto[];
  readonly freshness: FreshnessDto;
  readonly hits: readonly HitDto[];
  readonly suggested_queries: readonly string[];
  /** Exactly how this result was produced, so a run can be reproduced or explained. */
  readonly strategy: Readonly<Record<string, unknown>>;
  readonly stats: Readonly<Record<string, unknown>>;
  readonly warnings: readonly WarningDto[];
}

export interface ExploreResponseDto extends Omit<SearchResponseDto, "kind"> {
  readonly kind: "explore";
  readonly nodes: readonly GraphNodeDto[];
  readonly edges: readonly GraphEdgeDto[];
}

export interface ReadResponseDto extends ResponseEnvelope {
  readonly kind: "read";
  readonly corpus: string;
  readonly ref: string;
  readonly title: string;
  readonly text: string;
  readonly location: LocationDto;
  readonly total_lines: number;
  /** True when `text` is a subset of the document. Never truncated silently. */
  readonly truncated: boolean;
  readonly source_revision: string | null;
  readonly warnings: readonly WarningDto[];
}

export interface SourceInfoDto {
  readonly id: string;
  readonly kind: string;
  readonly uri: string;
  readonly revision: string | null;
  readonly document_count: number;
}

export interface CorpusInfoDto extends ResponseEnvelope {
  readonly kind: "corpus_info";
  readonly name: string;
  readonly path: string;
  readonly scope: string;
  readonly corpus_schema_version: string;
  readonly embedding: Readonly<Record<string, unknown>>;
  readonly chunking: Readonly<Record<string, unknown>>;
  readonly counts: Readonly<Record<string, number>>;
  readonly freshness: FreshnessDto;
  readonly sources: readonly SourceInfoDto[];
  /** False when the corpus cannot be searched as it stands. */
  readonly compatible: boolean;
  readonly incompatibility: string | null;
  readonly warnings: readonly WarningDto[];
}

export interface CorpusListEntryDto {
  readonly name: string;
  readonly scope: string;
  readonly path: string;
  readonly document_count: number;
  readonly chunk_count: number;
  readonly built_at: string | null;
  readonly compatible: boolean;
  readonly description: string;
}

export interface CorpusListDto extends ResponseEnvelope {
  readonly kind: "corpus_list";
  readonly corpora: readonly CorpusListEntryDto[];
  readonly warnings: readonly WarningDto[];
}

export interface BuildFailureDto {
  readonly ref: string;
  readonly stage: string;
  readonly code: string;
  readonly message: string;
  readonly at: string;
}

export interface BuildExclusionDto {
  readonly ref: string;
  readonly reason: string;
  readonly details: Readonly<Record<string, unknown>>;
}

export interface BuildReportDto extends ResponseEnvelope {
  readonly kind: "build_report";
  readonly corpus: string;
  /** `partial` when some files failed; never `ok` with failures present. */
  readonly status: "ok" | "partial";
  readonly documents: {
    readonly added: number;
    readonly modified: number;
    readonly deleted: number;
    readonly unchanged: number;
  };
  readonly chunks: number;
  readonly nodes: number;
  readonly edges: number;
  readonly failures: readonly BuildFailureDto[];
  readonly exclusions: readonly BuildExclusionDto[];
  readonly elapsed_seconds: number;
  readonly warnings: readonly WarningDto[];
}

/** What an archive says about the corpus inside it, as recorded when it was exported. */
export interface ArchiveManifestDto {
  readonly format_version: number;
  /** The corpus's name in the archive, which an import with `--as` does not change. */
  readonly corpus: string;
  readonly created_at: string;
  readonly created_by: string;
  readonly built_at: string;
  readonly identity: {
    readonly schema_version: string;
    readonly chunking_schema_version: string;
    readonly embedding_id: string;
    readonly chunking_fingerprint: string;
  };
  readonly counts: {
    readonly documents: number;
    readonly chunks: number;
    readonly nodes: number;
    readonly edges: number;
  };
  readonly sources: readonly { readonly id: string; readonly revision: string | null }[];
}

export interface ArchiveReportDto extends ResponseEnvelope {
  readonly kind: "archive_report";
  readonly operation: "export" | "import";
  /** The corpus on this machine: the one exported, or the name it was imported as. */
  readonly corpus: string;
  readonly archive_path: string;
  readonly bytes: number;
  /** Lowercase hex SHA-256 of the archive file, for checking a copy before import. */
  readonly checksum: string;
  /** Where an import landed; null for an export. */
  readonly destination: {
    readonly path: string;
    readonly scope: string;
    readonly replaced: boolean;
  } | null;
  readonly manifest: ArchiveManifestDto;
  readonly warnings: readonly WarningDto[];
}

/** One headline metric, as reported by an evaluation run. */
export interface EvaluationMetricsDto {
  readonly recall_at_k: number | null;
  readonly precision_at_k: number | null;
  readonly reciprocal_rank: number | null;
  readonly ndcg_at_k: number | null;
  readonly evidence_checked: number;
  readonly evidence_correct: number;
  readonly evidence_accuracy: number | null;
  readonly retrieved: number;
  readonly relevant: number;
}

export interface EvaluationQueryDto {
  readonly id: string;
  readonly query: string;
  readonly note: string | null;
  readonly metrics: EvaluationMetricsDto;
  readonly elapsed_ms: number;
  /** Refs returned, best first, so a regression is diffable without re-running. */
  readonly retrieved_refs: readonly string[];
  /** Judged refs that never appeared; the concrete shape of a recall failure. */
  readonly missing_refs: readonly string[];
  /** Set when the query itself threw; its metrics are then all null. */
  readonly error: string | null;
}

export interface EvaluationLatencyDto {
  readonly mean_ms: number | null;
  readonly p50_ms: number | null;
  readonly p95_ms: number | null;
  readonly max_ms: number | null;
}

export interface EvaluationSummaryDto {
  readonly queries: number;
  /** Queries the dataset could actually measure, i.e. that carried judgments. */
  readonly measured: number;
  readonly recall_at_k: number | null;
  readonly precision_at_k: number | null;
  readonly mrr: number | null;
  readonly ndcg_at_k: number | null;
  readonly evidence_accuracy: number | null;
  readonly evidence_checked: number;
  readonly zero_result_queries: number;
  readonly missed_queries: number;
  readonly failed_queries: number;
  readonly latency: EvaluationLatencyDto;
}

/** Why a run failed its gate: a floor it missed, or a baseline it fell below. */
export interface EvaluationGateDto {
  readonly kind: "threshold" | "regression";
  readonly metric: string;
  readonly observed: number | null;
  readonly required: number | null;
  readonly message: string;
}

/** One metric, then versus now. Present for every metric when a baseline is given. */
export interface EvaluationDeltaDto {
  readonly metric: string;
  readonly baseline: number | null;
  readonly current: number | null;
  readonly delta: number | null;
}

export interface EvaluationReportDto extends ResponseEnvelope {
  readonly kind: "evaluation_report";
  readonly dataset: string;
  readonly corpus: string;
  readonly embedding_id: string;
  /** Rank cutoff every @K metric in this report was computed at. */
  readonly k: number;
  /** The retrieval configuration measured, copied from the search pipeline. */
  readonly strategy: Readonly<Record<string, unknown>>;
  readonly summary: EvaluationSummaryDto;
  readonly queries: readonly EvaluationQueryDto[];
  /** Null when no baseline was supplied. */
  readonly comparison: readonly EvaluationDeltaDto[] | null;
  /** `failed` when a gate was breached; the run itself still completed. */
  readonly status: "ok" | "failed";
  readonly gate_failures: readonly EvaluationGateDto[];
  readonly warnings: readonly WarningDto[];
}

export interface ErrorDto {
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly details: Readonly<Record<string, unknown>>;
  };
}

/** Warning codes that appear in responses. Stable; additions only. */
export const WarningCode = {
  /** The corpus is behind its sources. */
  STALE_CORPUS: "stale_corpus",
  /** Nothing cleared the relevance threshold. */
  NO_SUFFICIENT_EVIDENCE: "no_sufficient_evidence",
  /** Some files failed to index; results may be incomplete. */
  PARTIAL_INDEX: "partial_index",
  /** The requested line range was clamped to the document. */
  RANGE_CLAMPED: "range_clamped",
  /** Reranking was requested but unavailable; results are unreranked. */
  RERANK_UNAVAILABLE: "rerank_unavailable",
  /** The corpus uses the built-in lexical embedder, not a semantic model. */
  LEXICAL_EMBEDDING: "lexical_embedding",
  /** A corpus was skipped while listing because it could not be opened. */
  CORPUS_UNREADABLE: "corpus_unreadable",
  /** A corpus was skipped during a cross-corpus search, and why. */
  CORPUS_SKIPPED: "corpus_skipped",
  /** Corpora with different embeddings were searched together. */
  MIXED_EMBEDDINGS: "mixed_embeddings",
  /** An extractor reported a non-fatal problem, e.g. a PDF page with no text. */
  EXTRACTION_NOTE: "extraction_note",
  /** An evaluation query threw; it is scored as a miss and named in the report. */
  EVAL_QUERY_FAILED: "eval_query_failed",
  /** The dataset names a ref that is not in the corpus, so it can never be found. */
  EVAL_UNKNOWN_REF: "eval_unknown_ref",
  /** An imported corpus shares its name with one that name resolution reaches first. */
  CORPUS_SHADOWED: "corpus_shadowed",
} as const;

export type WarningCodeValue = (typeof WarningCode)[keyof typeof WarningCode];

/** Round scores so identical inputs serialize identically on every machine. */
export function round(value: number | null | undefined, digits = 6): number | null {
  if (value === null || value === undefined || Number.isNaN(value)) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

/** Envelope fields, spread into every response. */
export function envelope<K extends string>(kind: K): ResponseEnvelope & { kind: K } {
  return { schema_version: SCHEMA_VERSION, contract_version: CONTRACT_VERSION, kind };
}
