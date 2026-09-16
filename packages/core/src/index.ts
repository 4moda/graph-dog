/**
 * `@graphdog/core` public surface.
 *
 * Exports the contract types, the use cases and the composition root. It
 * deliberately does *not* export the infrastructure adapters individually:
 * callers should go through `openCorpus`, so that every interface assembles a
 * corpus the same way and the CLI and MCP server cannot drift apart.
 */

export { VERSION } from "./version.ts";

// --- errors and exit codes ---------------------------------------------------
export {
  ArchiveError,
  ConfigError,
  ConflictError,
  ConflictError as CorpusConflictError,
  CorpusNotFoundError,
  ExitCode,
  ExtractionError,
  GraphDogError,
  IncompatibleCorpusError,
  NotFoundError,
  RefNotFoundError,
  UsageError,
  isGraphDogError,
  toGraphDogError,
} from "./domain/errors.ts";
export type { ExitCodeValue, ErrorPayload } from "./domain/errors.ts";

// --- wire contract -----------------------------------------------------------
export * from "./application/dto/contracts.ts";
export {
  toEdgeDto,
  toFreshnessDto,
  toHitDto,
  toLocationDto,
  toNodeDto,
  toScoresDto,
  toWarningDto,
  toWarningDtos,
} from "./application/dto/mappers.ts";
export type { HitView, Warning } from "./application/dto/mappers.ts";

// --- configuration -----------------------------------------------------------
export {
  DEFAULT_EMBEDDING,
  DEFAULT_RERANK,
  DEFAULT_SEARCH,
  defaultCorpusConfig,
} from "./application/config.ts";
export type {
  CorpusConfig,
  EmbeddingConfig,
  RerankConfig,
  SearchConfig,
} from "./application/config.ts";
export { DEFAULT_CHUNKING } from "./domain/service/chunker.ts";
export { DEFAULT_FUSION } from "./domain/service/fusion.ts";
export { DEFAULT_GRAPH_RULES } from "./domain/service/graph-builder.ts";

// --- use cases ---------------------------------------------------------------
export { buildCorpus } from "./application/usecase/build-corpus.ts";
export type { BuildOptions, BuildOutcome } from "./application/usecase/build-corpus.ts";
export { searchCorpus } from "./application/usecase/search-corpus.ts";
export type {
  SearchDependencies,
  SearchOptions,
  SearchOutcome,
} from "./application/usecase/search-corpus.ts";
export { exploreCorpus } from "./application/usecase/explore-corpus.ts";
export { searchCorpora } from "./application/usecase/search-corpora.ts";
export type {
  CorpusTarget,
  MultiCorpusOutcome,
  SearchCorporaDependencies,
} from "./application/usecase/search-corpora.ts";
export type { ExploreOptions, ExploreOutcome } from "./application/usecase/explore-corpus.ts";
export { readDocument, parseRefWithRange } from "./application/usecase/read-document.ts";
export type { ReadOptions, ReadOutcome } from "./application/usecase/read-document.ts";
export { describeCorpus, corpusFreshness } from "./application/usecase/describe-corpus.ts";
export type { DescribeOutcome } from "./application/usecase/describe-corpus.ts";
export { DEFAULT_EVAL_K, evaluateCorpus } from "./application/usecase/evaluate-corpus.ts";
export type {
  EvaluateOptions,
  EvaluatedQuery,
  EvaluationOutcome,
  LatencySummary,
} from "./application/usecase/evaluate-corpus.ts";

// --- evaluation --------------------------------------------------------------
export {
  DEFAULT_TOLERANCE,
  GATED_METRICS,
  checkGates,
  compareScores,
  gateScores,
  isGatedMetric,
  parseGateSpec,
} from "./domain/service/evaluation-gate.ts";
export type {
  GateFailure,
  GateOptions,
  GateScores,
  GatedMetric,
  MetricDelta,
} from "./domain/service/evaluation-gate.ts";
export {
  aggregate,
  dedupeByRef,
  evidenceAccuracy,
  indexJudgments,
  mean,
  ndcgAtK,
  percentile,
  precisionAtK,
  recallAtK,
  reciprocalRank,
  scoreQuery,
  spansOverlap,
} from "./domain/service/metrics.ts";
export type {
  AggregateMetrics,
  EvidenceAccuracy,
  Judgment,
  QueryMetrics,
  RetrievedItem,
} from "./domain/service/metrics.ts";
export {
  DATASET_VERSION,
  DEFAULT_GRADE,
  loadEvalDataset,
  parseEvalDataset,
} from "./infrastructure/config/eval-dataset.ts";
export type { EvalDataset, EvalQuery } from "./infrastructure/config/eval-dataset.ts";
export { baselineScoresFrom, toEvaluationReportDto } from "./application/dto/evaluation-mappers.ts";

// --- portable corpus archives ----------------------------------------------
export { exportCorpus } from "./application/usecase/export-corpus.ts";
export type { ExportDependencies, ExportOptions } from "./application/usecase/export-corpus.ts";
export { importCorpus } from "./application/usecase/import-corpus.ts";
export type { ImportDependencies, ImportOptions } from "./application/usecase/import-corpus.ts";
export type { ArchiveOutcome } from "./application/usecase/archive-checks.ts";
export { toArchiveManifestDto, toArchiveReportDto } from "./application/dto/archive-mappers.ts";
export {
  ARCHIVE_EXTENSION,
  ARCHIVE_FORMAT,
  ARCHIVE_FORMAT_VERSION,
  parseManifest,
  verifyArchive,
} from "./domain/model/corpus-manifest.ts";
export type { CorpusManifest } from "./domain/model/corpus-manifest.ts";

// --- composition -------------------------------------------------------------
export {
  assertCompatible,
  discoverCorpusNames,
  openCorpora,
  openCorpus,
  openResolvedCorpus,
} from "./composition/corpus-context.ts";
export type { CorpusContext, OpenCorpusOptions } from "./composition/corpus-context.ts";
export { exportCorpusArchive, importCorpusArchive } from "./composition/corpus-archive.ts";
export type { ExportArchiveOptions, ImportArchiveOptions } from "./composition/corpus-archive.ts";
export {
  GIT_HOOKS,
  installAgentIntegration,
  knownPlatforms,
  uninstallAgentIntegration,
} from "./composition/agent-integration.ts";
export type {
  IntegrationChange,
  IntegrationOutcome,
  InstallIntegrationOptions,
  UninstallIntegrationOptions,
} from "./composition/agent-integration.ts";
export type { IntegrationScope } from "./domain/model/installation.ts";
export { runDoctor } from "./composition/doctor.ts";
export type { DoctorFinding, DoctorOptions, DoctorReport } from "./composition/doctor.ts";

// --- workspace ---------------------------------------------------------------
export {
  WORKSPACE_DIRNAME,
  corpusConfigPath,
  corpusDir,
  corpusStorePath,
  findProjectWorkspace,
  homeWorkspace,
  initProjectWorkspace,
  listCorpusNames,
  readCorpusConfig,
  resolveCorpus,
  visibleWorkspaces,
  writeCorpusConfig,
} from "./infrastructure/config/workspace.ts";
export type { ResolvedCorpus, Workspace, WorkspaceScope } from "./infrastructure/config/workspace.ts";
export { CONFIG_FILENAME, saveCorpusConfig } from "./infrastructure/config/corpus-config-file.ts";
export { normalizeSourceSpec, SUPPORTED_SOURCE_KINDS } from "./infrastructure/source/source-reader-factory.ts";
export type { SourceSpec } from "./application/ports/sources.ts";
export { createStderrLogger, sha256Hasher, systemClock } from "./infrastructure/system-adapters.ts";
export type { Logger, LogLevel } from "./application/ports/system.ts";
