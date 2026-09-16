/**
 * Human-readable rendering.
 *
 * Strictly separate from the JSON contract: `--json` never passes through this
 * file, and this file never decides what a result *is*. Mixing the two is how
 * the predecessor ended up with a display threshold that quietly dropped hits
 * from output that the caller had no way to know about.
 *
 * Everything here goes to stdout as prose. It may reformat, elide and colour
 * freely, precisely because nothing machine-readable depends on it.
 */

import type {
  ArchiveReportDto,
  BuildReportDto,
  BuildReportsDto,
  CorpusInfoDto,
  CorpusListDto,
  DoctorReportDto,
  EvaluationDeltaDto,
  EvaluationReportDto,
  ExploreResponseDto,
  HitDto,
  IntegrationReportDto,
  ReadResponseDto,
  SearchResponseDto,
  WarningDto,
} from "@graphdog/core";

export interface RenderOptions {
  /** ANSI colour. Off when stdout is not a TTY, so piped output stays clean. */
  readonly color: boolean;
  readonly width: number;
}

export function defaultRenderOptions(): RenderOptions {
  return {
    color: process.stdout.isTTY === true && process.env["NO_COLOR"] === undefined,
    width: Math.max(60, Math.min(process.stdout.columns ?? 100, 120)),
  };
}

const CODES = {
  reset: "\u001b[0m",
  bold: "\u001b[1m",
  dim: "\u001b[2m",
  red: "\u001b[31m",
  green: "\u001b[32m",
  yellow: "\u001b[33m",
  blue: "\u001b[34m",
  cyan: "\u001b[36m",
} as const;

function paint(options: RenderOptions, code: keyof typeof CODES, text: string): string {
  return options.color ? `${CODES[code]}${text}${CODES.reset}` : text;
}

/** The fields `search` and `explore` share; `explore` adds nodes and edges. */
type SearchBody = Omit<SearchResponseDto, "kind">;

export function renderSearch(
  response: SearchBody,
  options: RenderOptions = defaultRenderOptions(),
): string {
  const lines: string[] = [];

  if (response.hits.length === 0) {
    lines.push(paint(options, "yellow", "No sufficient evidence found."));
    lines.push(
      paint(options, "dim", `  query: ${response.query}   corpus: ${response.corpus}`),
    );
    lines.push(...renderWarnings(response.warnings, options));
    lines.push(
      "",
      paint(options, "dim", "  Try broader terms, or 'graphdog explore' to follow the graph."),
    );
    return `${lines.join("\n")}\n`;
  }

  // Only label hits by corpus when more than one was searched: on a
  // single-corpus project the label is the same on every line and adds nothing.
  const searched = response.corpora.filter((entry) => entry.searched).length;
  const showCorpus = searched > 1;

  lines.push(
    paint(options, "bold", `${response.hits.length} result(s)`) +
      paint(options, "dim", ` for "${response.query}" in ${response.corpus}`),
  );
  lines.push("");

  response.hits.forEach((hit, index) => {
    lines.push(...renderHit(hit, index + 1, options, showCorpus));
    lines.push("");
  });

  const skipped = response.corpora.filter((entry) => !entry.searched);
  if (skipped.length > 0) {
    lines.push(
      paint(
        options,
        "yellow",
        `Not searched: ${skipped.map((entry) => entry.name).join(", ")}`,
      ),
    );
  }

  if (response.suggested_queries.length > 0) {
    lines.push(
      paint(options, "dim", `Related terms: ${response.suggested_queries.join(", ")}`),
    );
  }
  lines.push(paint(options, "dim", renderStrategy(response)));
  lines.push(...renderWarnings(response.warnings, options));
  return `${lines.join("\n")}\n`;
}

function renderHit(
  hit: HitDto,
  position: number,
  options: RenderOptions,
  showCorpus = false,
): string[] {
  const score = hit.scores.final.toFixed(3);
  const heading = hit.heading_path === "" ? "" : paint(options, "dim", ` > ${hit.heading_path}`);
  const corpus = showCorpus ? paint(options, "blue", `[${hit.corpus}] `) : "";
  // Rank within its own corpus, which is what the cross-corpus score was fused
  // from -- shown so "second overall" and "best in its corpus" stay legible.
  const rank = showCorpus ? paint(options, "dim", ` #${hit.corpus_rank} in ${hit.corpus}`) : "";

  const lines = [
    `${paint(options, "bold", `${position}. ${corpus}${hit.title}`)}${heading}`,
    `   ${paint(options, "cyan", hit.read_ref)}  ${paint(options, "dim", `score ${score} via ${hit.found_by}`)}${rank}`,
  ];

  if (hit.snippet !== "") {
    lines.push(`   ${wrap(hit.snippet, options.width - 3, "   ")}`);
  }

  // The per-signal breakdown is the point of the tool: it is how someone
  // decides whether a hit is a real match or a graph-adjacent guess.
  const signals: string[] = [];
  if (hit.scores.dense !== null) signals.push(`dense ${hit.scores.dense.toFixed(2)}`);
  if (hit.scores.bm25 !== null) signals.push(`bm25 ${hit.scores.bm25.toFixed(2)}`);
  if (hit.scores.graph !== null && hit.scores.graph > 0) {
    signals.push(`graph ${hit.scores.graph.toFixed(2)}`);
  }
  if (hit.scores.rerank !== null) signals.push(`rerank ${hit.scores.rerank.toFixed(2)}`);
  if (signals.length > 0) lines.push(`   ${paint(options, "dim", signals.join("  "))}`);

  if (hit.graph_path.length > 0) {
    const chain = hit.graph_path
      .map((edge) => `${edge.relation} ${shortNode(edge.dst)}`)
      .join(" -> ");
    lines.push(`   ${paint(options, "dim", `reached via: ${chain}`)}`);
  }
  return lines;
}

function shortNode(nodeId: string): string {
  const separator = nodeId.indexOf(":");
  return separator < 0 ? nodeId : nodeId.slice(separator + 1);
}

function renderStrategy(response: SearchBody): string {
  const strategy = response.strategy;
  const fusion = String(strategy["fusion"] ?? "?");
  const parts = [`fusion=${fusion}`];

  if (strategy["per_corpus"] === undefined) {
    // Single corpus: report the signals directly.
    parts.push(
      `dense=${String(strategy["dense"] ?? "off")}`,
      `lexical=${String(strategy["lexical"] ?? "off")}`,
      `graph=${String(strategy["graph"] ?? "off")}`,
    );
    if (strategy["rerank"] !== undefined && strategy["rerank"] !== "off") {
      parts.push(`rerank=${String(strategy["rerank"])}`);
    }
  } else {
    // Several corpora: the per-corpus strategies are in the JSON, and
    // summarizing them into one line would misrepresent them.
    parts.push(`corpora=${String(strategy["corpora"] ?? 0)}`);
  }

  const elapsed = response.stats["elapsed_ms"];
  if (typeof elapsed === "number") parts.push(`${elapsed}ms`);
  return parts.join("  ");
}

export function renderExplore(
  response: ExploreResponseDto,
  options: RenderOptions = defaultRenderOptions(),
): string {
  const lines = [renderSearch(response, options).trimEnd()];

  if (response.nodes.length > 0) {
    lines.push("", paint(options, "bold", "Neighbourhood"));
    const documents = response.nodes.filter((node) => node.kind === "document").length;
    const tags = response.nodes.filter((node) => node.kind === "tag");
    const directories = response.nodes.filter((node) => node.kind === "directory");
    lines.push(
      paint(
        options,
        "dim",
        `  ${documents} document(s), ${response.edges.length} edge(s)`,
      ),
    );
    if (tags.length > 0) {
      lines.push(paint(options, "dim", `  tags: ${tags.map((n) => n.label).join(", ")}`));
    }
    if (directories.length > 0) {
      lines.push(
        paint(options, "dim", `  areas: ${directories.map((n) => n.label).join(", ")}`),
      );
    }
  }
  return `${lines.join("\n")}\n`;
}

export function renderRead(
  response: ReadResponseDto,
  options: RenderOptions = defaultRenderOptions(),
): string {
  const header = [
    paint(options, "bold", response.title),
    paint(
      options,
      "dim",
      `${response.ref}  lines ${response.location.start_line}-${response.location.end_line}` +
        ` of ${response.total_lines}` +
        (response.source_revision === null ? "" : `  @ ${response.source_revision.slice(0, 8)}`),
    ),
    "",
  ];
  const footer = renderWarnings(response.warnings, options);
  return `${[...header, response.text, ...footer].join("\n")}\n`;
}

export function renderStatus(
  info: CorpusInfoDto,
  options: RenderOptions = defaultRenderOptions(),
): string {
  const lines: string[] = [
    paint(options, "bold", `corpus ${info.name}`) + paint(options, "dim", `  (${info.scope})`),
    paint(options, "dim", `  ${info.path}`),
    "",
  ];

  const freshnessColor =
    info.freshness.status === "current" ? "green" : info.freshness.status === "stale" ? "yellow" : "dim";
  lines.push(
    `  freshness   ${paint(options, freshnessColor, info.freshness.status)}` +
      (info.freshness.built_at === null ? "" : paint(options, "dim", `  built ${info.freshness.built_at}`)),
  );
  if (info.freshness.reason !== null) {
    lines.push(paint(options, "dim", `              ${info.freshness.reason}`));
  }

  lines.push(
    `  compatible  ${info.compatible ? paint(options, "green", "yes") : paint(options, "red", "no")}`,
  );
  if (info.incompatibility !== null) {
    lines.push(paint(options, "red", `              ${info.incompatibility}`));
  }

  lines.push(
    "",
    `  documents   ${info.counts["documents"] ?? 0}`,
    `  chunks      ${info.counts["chunks"] ?? 0}`,
    `  vectors     ${info.counts["vectors"] ?? 0}`,
    `  graph       ${info.counts["nodes"] ?? 0} node(s), ${info.counts["edges"] ?? 0} edge(s)`,
  );

  const failures = info.counts["failures"] ?? 0;
  if (failures > 0) lines.push(paint(options, "yellow", `  failures    ${failures}`));
  const exclusions = info.counts["exclusions"] ?? 0;
  if (exclusions > 0) lines.push(paint(options, "dim", `  excluded    ${exclusions}`));

  lines.push(
    "",
    `  embedding   ${String(info.embedding["id"] ?? "-")}` +
      (info.embedding["semantic"] === true ? "" : paint(options, "dim", "  (lexical)")),
  );

  if (info.sources.length > 0) {
    lines.push("", paint(options, "bold", "  sources"));
    for (const source of info.sources) {
      const revision = source.revision === null ? "" : ` @ ${source.revision.slice(0, 8)}`;
      lines.push(
        `    ${source.id.padEnd(16)} ${source.kind.padEnd(6)} ${source.document_count} doc(s)` +
          paint(options, "dim", `${revision}  ${source.uri}`),
      );
    }
  }

  lines.push(...renderWarnings(info.warnings, options));
  return `${lines.join("\n")}\n`;
}

export function renderCorpusList(
  list: CorpusListDto,
  options: RenderOptions = defaultRenderOptions(),
): string {
  if (list.corpora.length === 0) {
    return `${paint(options, "dim", "No corpora found. Run 'graphdog init' to create one.")}\n`;
  }
  const lines = [paint(options, "bold", `${list.corpora.length} corpus/corpora`), ""];
  for (const entry of list.corpora) {
    const state = entry.compatible ? "" : paint(options, "red", "  [incompatible]");
    lines.push(
      `  ${entry.name.padEnd(20)} ${paint(options, "dim", entry.scope.padEnd(8))}` +
        `${String(entry.document_count).padStart(5)} doc  ` +
        `${String(entry.chunk_count).padStart(6)} chunk${state}`,
    );
    if (entry.description !== "") {
      lines.push(paint(options, "dim", `    ${entry.description}`));
    }
  }
  lines.push(...renderWarnings(list.warnings, options));
  return `${lines.join("\n")}\n`;
}

export function renderBuildReport(
  report: BuildReportDto,
  options: RenderOptions = defaultRenderOptions(),
): string {
  const statusColor = report.status === "ok" ? "green" : "yellow";
  const lines = [
    `${paint(options, statusColor, report.status)} ${paint(options, "dim", `(${report.elapsed_seconds.toFixed(2)}s)`)}`,
    `  ${report.documents.added} added, ${report.documents.modified} modified, ` +
      `${report.documents.deleted} deleted, ${report.documents.unchanged} unchanged`,
    `  ${report.chunks} chunk(s), ${report.nodes} node(s), ${report.edges} edge(s)`,
  ];

  if (report.failures.length > 0) {
    lines.push("", paint(options, "yellow", `  ${report.failures.length} file(s) failed:`));
    for (const failure of report.failures.slice(0, 10)) {
      lines.push(`    ${failure.ref}: ${failure.message}`);
    }
    if (report.failures.length > 10) {
      lines.push(paint(options, "dim", `    ... and ${report.failures.length - 10} more`));
    }
  }

  const secrets = report.exclusions.filter((entry) => entry.reason === "secret_pattern");
  if (secrets.length > 0) {
    lines.push(
      paint(options, "dim", `  ${secrets.length} file(s) skipped as secrets (see --json for the list)`),
    );
  }

  lines.push(...renderWarnings(report.warnings, options));
  return `${lines.join("\n")}\n`;
}

/**
 * An evaluation report, as a table a person can scan.
 *
 * Headline numbers first, then the deltas if a baseline was given, then the
 * queries that did worst. The worst queries are the useful part: an aggregate
 * that dropped two points tells you something changed, and the per-query list
 * tells you where to look.
 */
export function renderEvaluation(
  report: EvaluationReportDto,
  options: RenderOptions = defaultRenderOptions(),
): string {
  const { summary } = report;
  const statusColor = report.status === "ok" ? "green" : "red";

  const lines: string[] = [
    `${paint(options, "bold", report.dataset)} on ${paint(options, "cyan", report.corpus)} ` +
      paint(options, "dim", `(${summary.queries} queries, k=${report.k}, ${report.embedding_id})`),
    "",
  ];

  const rows: Array<[string, string]> = [
    [`recall@${report.k}`, ratio(summary.recall_at_k)],
    [`precision@${report.k}`, ratio(summary.precision_at_k)],
    ["mrr", ratio(summary.mrr)],
    [`ndcg@${report.k}`, ratio(summary.ndcg_at_k)],
    [
      "evidence",
      summary.evidence_checked === 0
        ? paint(options, "dim", "n/a (no spans judged)")
        : `${ratio(summary.evidence_accuracy)} ${paint(options, "dim", `(${summary.evidence_checked} span(s) checked)`)}`,
    ],
  ];
  const deltas = new Map((report.comparison ?? []).map((entry) => [entry.metric, entry]));
  const keys = ["recall", "precision", "mrr", "ndcg", "evidence"];
  rows.forEach(([label, value], index) => {
    const delta = deltas.get(keys[index] ?? "");
    lines.push(`  ${label.padEnd(14)}${value.padEnd(10)}${renderDelta(delta, options)}`);
  });

  lines.push(
    "",
    paint(
      options,
      "dim",
      `  ${summary.measured}/${summary.queries} measurable, ${summary.missed_queries} missed, ` +
        `${summary.zero_result_queries} returned nothing` +
        (summary.failed_queries > 0 ? `, ${summary.failed_queries} errored` : ""),
    ),
    paint(
      options,
      "dim",
      `  latency  p50 ${millis(summary.latency.p50_ms)}  p95 ${millis(summary.latency.p95_ms)}  max ${millis(summary.latency.max_ms)}`,
    ),
  );

  const worst = [...report.queries]
    .filter((query) => query.error !== null || (query.metrics.reciprocal_rank ?? 1) < 1)
    .sort((left, right) => rankOf(left) - rankOf(right))
    .slice(0, 5);

  if (worst.length > 0) {
    lines.push("", paint(options, "yellow", "  weakest queries:"));
    for (const query of worst) {
      const detail =
        query.error !== null
          ? paint(options, "red", `error: ${query.error}`)
          : query.metrics.reciprocal_rank === 0
            ? paint(options, "red", "not found")
            : paint(options, "dim", `rank ${Math.round(1 / (query.metrics.reciprocal_rank ?? 1))}`);
      lines.push(`    ${query.id.padEnd(20)}${detail}`);
      if (query.missing_refs.length > 0) {
        lines.push(paint(options, "dim", `      missing: ${query.missing_refs.slice(0, 3).join(", ")}`));
      }
    }
  }

  if (report.gate_failures.length > 0) {
    lines.push("", paint(options, statusColor, "  gate failed:"));
    for (const failure of report.gate_failures) {
      lines.push(paint(options, "red", `    ${failure.message}`));
    }
  } else if (report.comparison !== null) {
    lines.push("", paint(options, "green", "  no regression against the baseline"));
  }

  lines.push(...renderWarnings(report.warnings, options));
  return `${lines.join("\n")}\n`;
}

/** `0.812`, or `--` when the dataset could not measure it. */
function ratio(value: number | null): string {
  return value === null ? "--" : value.toFixed(3);
}

function millis(value: number | null): string {
  return value === null ? "--" : `${value.toFixed(0)}ms`;
}

function renderDelta(delta: EvaluationDeltaDto | undefined, options: RenderOptions): string {
  if (delta === undefined || delta.delta === null) return "";
  if (delta.delta === 0) return paint(options, "dim", "  =");
  const sign = delta.delta > 0 ? "+" : "";
  return paint(options, delta.delta > 0 ? "green" : "red", `  ${sign}${delta.delta.toFixed(3)}`);
}

/** Sort key for "worst first": a miss sorts before a low rank. */
function rankOf(query: EvaluationReportDto["queries"][number]): number {
  if (query.error !== null) return -1;
  return query.metrics.reciprocal_rank ?? 1;
}

/**
 * An export or import, as a short receipt.
 *
 * The checksum is always shown: it is what lets someone confirm the file they
 * hand on, or the one they received, is the one this command wrote or checked.
 */
export function renderArchiveReport(
  report: ArchiveReportDto,
  options: RenderOptions = defaultRenderOptions(),
): string {
  const { manifest } = report;
  const lines: string[] = [];

  if (report.operation === "export") {
    lines.push(
      `${paint(options, "green", "exported")} ${paint(options, "bold", report.corpus)} to ${report.archive_path} ` +
        paint(options, "dim", `(${formatBytes(report.bytes)})`),
    );
  } else {
    const verb = report.destination?.replaced === true ? "replaced" : "imported";
    const renamed = report.corpus === manifest.corpus ? "" : ` as ${paint(options, "bold", report.corpus)}`;
    lines.push(
      `${paint(options, "green", verb)} ${paint(options, "bold", manifest.corpus)}${renamed} from ${report.archive_path}`,
    );
    if (report.destination !== null) {
      lines.push(`  into ${report.destination.path} ${paint(options, "dim", `(${report.destination.scope} workspace)`)}`);
    }
  }

  lines.push(
    `  ${manifest.counts.documents} document(s), ${manifest.counts.chunks} chunk(s), ` +
      `${manifest.counts.nodes} node(s), ${manifest.counts.edges} edge(s)`,
    `  built ${manifest.built_at} with ${manifest.identity.embedding_id}`,
  );
  if (manifest.sources.length > 0) {
    const sources = manifest.sources.map((source) =>
      source.revision === null ? source.id : `${source.id}@${source.revision.slice(0, 12)}`,
    );
    lines.push(`  sources ${sources.join(", ")}`);
  }
  lines.push(paint(options, "dim", `  sha256 ${report.checksum}`));

  if (report.operation === "import") {
    lines.push(
      paint(options, "dim", `  verified: checksums, schema, database integrity, manifest against contents`),
      "",
      `Search it with: graphdog search "<query>" --corpus ${report.corpus}`,
    );
  }

  lines.push(...renderWarnings(report.warnings, options));
  return `${lines.join("\n")}\n`;
}

/** `20 KB`, `1.5 MB`: enough precision to recognise a file, no more. */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unit]}`;
}

export function renderWarnings(
  warnings: readonly WarningDto[],
  options: RenderOptions = defaultRenderOptions(),
): string[] {
  if (warnings.length === 0) return [];
  return ["", ...warnings.map((warning) => paint(options, "yellow", `! ${warning.message}`))];
}

export function renderError(
  code: string,
  message: string,
  details: Readonly<Record<string, unknown>>,
  options: RenderOptions = defaultRenderOptions(),
): string {
  const lines = [paint(options, "red", `error [${code}]: ${message}`)];
  const hint = details["hint"];
  if (typeof hint === "string") lines.push(paint(options, "dim", `  hint: ${hint}`));
  const remedy = details["remedy"];
  if (typeof remedy === "string") lines.push(paint(options, "dim", `  try: ${remedy}`));
  const available = details["available"];
  if (Array.isArray(available) && available.length > 0) {
    lines.push(paint(options, "dim", `  available: ${available.join(", ")}`));
  }
  return `${lines.join("\n")}\n`;
}

/** Soft-wrap a single paragraph, indenting continuation lines. */
function wrap(text: string, width: number, indent: string): string {
  if (text.length <= width) return text;
  const words = text.split(" ");
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    if (current === "") {
      current = word;
    } else if (current.length + 1 + word.length <= width) {
      current += ` ${word}`;
    } else {
      lines.push(current);
      current = word;
    }
  }
  if (current !== "") lines.push(current);
  return lines.join(`\n${indent}`);
}

/**
 * Several corpora built in one command.
 *
 * Each report is named, which a single build does not need to be -- there the
 * reader knows which corpus they asked for, and here they do not.
 */
export function renderBuildReports(
  report: BuildReportsDto,
  options: RenderOptions = defaultRenderOptions(),
): string {
  return report.reports
    .map((one) => `${paint(options, "bold", one.corpus)}  ${renderBuildReport(one, options)}`)
    .join("");
}

/**
 * What an install or uninstall did, one line per file.
 *
 * The path is always shown, including for a `--dry-run`, because the question
 * this answers is "what are you about to write in my repository" and an answer
 * that names a platform rather than a file does not answer it.
 */
export function renderIntegrationReport(
  report: IntegrationReportDto,
  options: RenderOptions = defaultRenderOptions(),
): string {
  const lines: string[] = [];
  const platforms = report.platforms.join(", ");
  const scope = report.scope === null ? "" : ` (${report.scope} scope)`;
  const verb = report.dry_run
    ? `would ${report.operation === "install" ? "connect" : "remove"}`
    : report.operation === "install"
      ? "connected"
      : "removed";
  lines.push(
    `${paint(options, report.dry_run ? "yellow" : "green", verb)} ${paint(options, "bold", platforms)}${scope}` +
      (report.root === null ? "" : ` in ${report.root}`),
  );

  const colour: Record<IntegrationReportDto["changes"][number]["action"], "green" | "cyan" | "dim"> = {
    created: "green",
    updated: "cyan",
    removed: "green",
    unchanged: "dim",
    absent: "dim",
  };
  for (const change of report.changes) {
    const at = change.at === null || change.kind === "block" ? "" : ` ${paint(options, "dim", change.at)}`;
    const size = change.bytes === undefined ? "" : ` ${paint(options, "dim", `(${formatBytes(change.bytes)})`)}`;
    lines.push(`  ${paint(options, colour[change.action], change.action.padEnd(9))} ${change.path}${at}${size}`);
  }

  if (report.operation === "install" && !report.dry_run) {
    lines.push(paint(options, "dim", "  restart the agent to pick up the new server"));
  }
  return `${lines.join("\n")}\n`;
}

/**
 * The doctor report, grouped by section, with each remedy under its finding.
 *
 * Sorted by section rather than severity so the same thing is always in the
 * same place; a problem is found by its colour and its `->`, not by scanning.
 */
export function renderDoctorReport(
  report: DoctorReportDto,
  options: RenderOptions = defaultRenderOptions(),
): string {
  const lines = [
    `${paint(options, "bold", `graphdog ${report.graphdog_version}`)} ${paint(options, "dim", `node ${report.node_version}`)}`,
  ];

  let section = "";
  for (const finding of report.findings) {
    const heading = finding.section === section ? "        " : finding.section.padEnd(8);
    section = finding.section;
    const mark =
      finding.status === "broken"
        ? paint(options, "red", "x")
        : finding.status === "warn"
          ? paint(options, "yellow", "!")
          : paint(options, "green", "-");
    lines.push(`${heading} ${mark} ${paint(options, "bold", finding.label)}  ${finding.detail}`);
    if (finding.remedy !== null && finding.status !== "ok") {
      lines.push(`${" ".repeat(10)}${paint(options, "dim", `-> ${finding.remedy}`)}`);
    }
  }

  lines.push(
    "",
    report.healthy
      ? paint(options, "green", "nothing is broken")
      : paint(options, "red", "something is broken; see the lines marked x"),
  );
  return `${lines.join("\n")}\n`;
}
