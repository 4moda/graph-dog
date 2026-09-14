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
  BuildReportDto,
  CorpusInfoDto,
  CorpusListDto,
  ExploreResponseDto,
  HitDto,
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

  lines.push(
    paint(options, "bold", `${response.hits.length} result(s)`) +
      paint(options, "dim", ` for "${response.query}" in ${response.corpus}`),
  );
  lines.push("");

  response.hits.forEach((hit, index) => {
    lines.push(...renderHit(hit, index + 1, options));
    lines.push("");
  });

  if (response.suggested_queries.length > 0) {
    lines.push(
      paint(options, "dim", `Related terms: ${response.suggested_queries.join(", ")}`),
    );
  }
  lines.push(paint(options, "dim", renderStrategy(response)));
  lines.push(...renderWarnings(response.warnings, options));
  return `${lines.join("\n")}\n`;
}

function renderHit(hit: HitDto, position: number, options: RenderOptions): string[] {
  const score = hit.scores.final.toFixed(3);
  const heading = hit.heading_path === "" ? "" : paint(options, "dim", ` > ${hit.heading_path}`);

  const lines = [
    `${paint(options, "bold", `${position}. ${hit.title}`)}${heading}`,
    `   ${paint(options, "cyan", hit.read_ref)}  ${paint(options, "dim", `score ${score} via ${hit.found_by}`)}`,
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
  const parts = [
    `fusion=${String(strategy["fusion"] ?? "?")}`,
    `dense=${String(strategy["dense"] ?? "off")}`,
    `lexical=${String(strategy["lexical"] ?? "off")}`,
    `graph=${String(strategy["graph"] ?? "off")}`,
  ];
  if (strategy["rerank"] !== "off") parts.push(`rerank=${String(strategy["rerank"])}`);
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
