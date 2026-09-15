import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type {
  ArchiveReportDto,
  BuildReportDto,
  CorpusInfoDto,
  CorpusListDto,
  EvaluationReportDto,
  ExploreResponseDto,
  HitDto,
  ReadResponseDto,
  SearchResponseDto,
} from "@graphdog/core";

import {
  defaultRenderOptions,
  renderArchiveReport,
  renderBuildReport,
  renderCorpusList,
  renderError,
  renderEvaluation,
  renderExplore,
  renderRead,
  renderSearch,
  renderStatus,
  renderWarnings,
  type RenderOptions,
} from "./human-renderer.ts";

/** Colour off, so assertions match plain text rather than escape sequences. */
const plain: RenderOptions = { color: false, width: 100 };

const ENVELOPE = { schema_version: "1", contract_version: "1.0" } as const;

function hit(overrides: Partial<HitDto> = {}): HitDto {
  return {
    corpus: "demo",
    corpus_rank: 1,
    ref: "docs/design/token.md",
    chunk_id: "abc123",
    title: "Access Token",
    heading_path: "Design > Tokens",
    snippet: "Access tokens are JWT values signed with ES256.",
    location: { start_line: 10, end_line: 24, start_char: 100, end_char: 500 },
    scores: { dense: 0.91, bm25: 0.78, graph: 0, rerank: null, final: 0.86 },
    found_by: "dense",
    graph_path: [],
    source_revision: "deadbeefcafe",
    tags: ["auth"],
    read_ref: "docs/design/token.md#L10-L24",
    ...overrides,
  };
}

function search(overrides: Partial<SearchResponseDto> = {}): SearchResponseDto {
  return {
    ...ENVELOPE,
    kind: "search",
    query: "JWT",
    corpus: "demo",
    corpora: [
      { name: "demo", scope: "project", embedding_id: "hash-v1:d256", hits: 1,
        searched: true, skipped_reason: null },
    ],
    freshness: { status: "current", built_at: "2026-09-14T00:00:00.000Z", source_revisions: {}, reason: null },
    hits: [hit()],
    suggested_queries: ["ES256"],
    strategy: { fusion: "rrf", dense: "hash-v1:d256", lexical: "bm25", graph: "expansion:2hop", rerank: "off" },
    stats: { elapsed_ms: 5 },
    warnings: [],
    ...overrides,
  };
}

describe("cli/infrastructure/render/humanRenderer", () => {
  describe("defaultRenderOptions", () => {
    it("produces a usable width", () => {
      assert.ok(defaultRenderOptions().width >= 60);
    });
  });

  describe("renderSearch", () => {
    it("shows the hit count, title and ref", () => {
      const output = renderSearch(search(), plain);
      assert.match(output, /1 result\(s\)/);
      assert.match(output, /Access Token/);
      assert.match(output, /docs\/design\/token\.md#L10-L24/);
    });

    it("shows the ready-to-use read_ref, not a bare path", () => {
      // An agent copying from the terminal should get something `read` accepts.
      assert.match(renderSearch(search(), plain), /#L10-L24/);
    });

    it("breaks down the per-signal scores, which is the point of the tool", () => {
      const output = renderSearch(search(), plain);
      assert.match(output, /dense 0\.91/);
      assert.match(output, /bm25 0\.78/);
    });

    it("omits a signal that did not run rather than printing a fake zero", () => {
      const output = renderSearch(
        search({ hits: [hit({ scores: { dense: null, bm25: 0.5, graph: 0, rerank: null, final: 0.5 } })] }),
        plain,
      );
      assert.doesNotMatch(output, /dense /);
      assert.match(output, /bm25 0\.50/);
    });

    it("shows the rerank score when reranking ran", () => {
      const output = renderSearch(
        search({ hits: [hit({ scores: { dense: 0.5, bm25: 0.5, graph: 0, rerank: 0.99, final: 0.9 } })] }),
        plain,
      );
      assert.match(output, /rerank 0\.99/);
    });

    it("explains how a graph-reached hit was found", () => {
      const output = renderSearch(
        search({
          hits: [
            hit({
              found_by: "graph",
              graph_path: [
                { src: "doc:a.md", dst: "doc:b.md", kind: "links_to", weight: 1, relation: "links to" },
              ],
            }),
          ],
        }),
        plain,
      );
      assert.match(output, /reached via: links to b\.md/);
    });

    it("says plainly when nothing was found", () => {
      const output = renderSearch(search({ hits: [], warnings: [] }), plain);
      assert.match(output, /No sufficient evidence/);
      assert.match(output, /explore/, "should suggest a next step");
    });

    it("prints warnings", () => {
      const output = renderSearch(
        search({ warnings: [{ code: "stale_corpus", message: "corpus is behind", details: {} }] }),
        plain,
      );
      assert.match(output, /! corpus is behind/);
    });

    it("reports the strategy that produced the result", () => {
      assert.match(renderSearch(search(), plain), /fusion=rrf/);
    });

    it("lists suggested follow-up queries", () => {
      assert.match(renderSearch(search(), plain), /Related terms: ES256/);
    });

    it("emits no ANSI codes when colour is off", () => {
      assert.doesNotMatch(renderSearch(search(), plain), /\u001b\[/);
    });

    it("emits ANSI codes when colour is on", () => {
      assert.match(renderSearch(search(), { ...plain, color: true }), /\u001b\[/);
    });

    it("wraps a long snippet instead of overflowing the terminal", () => {
      const long = "word ".repeat(200);
      const output = renderSearch(search({ hits: [hit({ snippet: long })] }), { ...plain, width: 60 });
      // Only prose is wrapped. The strategy line is a run of single tokens that
      // would be less readable broken, so it is left alone deliberately.
      const snippetLines = output.split("\n").filter((line) => line.includes("word"));
      assert.ok(snippetLines.length > 1, "a long snippet should occupy several lines");
      for (const line of snippetLines) {
        assert.ok(line.length <= 60, `snippet line was ${line.length} chars: ${line}`);
      }
    });
  });

  describe("renderExplore", () => {
    function explore(): ExploreResponseDto {
      return {
        ...search(),
        kind: "explore",
        nodes: [
          { id: "doc:a.md", kind: "document", label: "A", ref: "a.md" },
          { id: "tag:auth", kind: "tag", label: "auth", ref: null },
          { id: "dir:docs", kind: "directory", label: "docs", ref: null },
        ],
        edges: [{ src: "doc:a.md", dst: "tag:auth", kind: "same_tag", weight: 0.5, relation: "shares a tag with" }],
      };
    }

    it("includes the search rendering", () => {
      assert.match(renderExplore(explore(), plain), /Access Token/);
    });

    it("summarizes the neighbourhood", () => {
      const output = renderExplore(explore(), plain);
      assert.match(output, /Neighbourhood/);
      assert.match(output, /tags: auth/);
      assert.match(output, /areas: docs/);
    });
  });

  describe("renderRead", () => {
    function read(overrides: Partial<ReadResponseDto> = {}): ReadResponseDto {
      return {
        ...ENVELOPE,
        kind: "read",
        corpus: "demo",
        ref: "docs/a.md",
        title: "Doc A",
        text: "line one\nline two",
        location: { start_line: 1, end_line: 2, start_char: 0, end_char: 17 },
        total_lines: 2,
        truncated: false,
        source_revision: "deadbeefcafe",
        warnings: [],
        ...overrides,
      };
    }

    it("prints the text verbatim", () => {
      assert.match(renderRead(read(), plain), /line one\nline two/);
    });

    it("shows the range it returned and the document's true length", () => {
      assert.match(renderRead(read(), plain), /lines 1-2 of 2/);
    });

    it("shows a short source revision", () => {
      assert.match(renderRead(read(), plain), /@ deadbeef/);
    });

    it("surfaces a truncation warning", () => {
      const output = renderRead(
        read({ truncated: true, warnings: [{ code: "range_clamped", message: "output truncated", details: {} }] }),
        plain,
      );
      assert.match(output, /! output truncated/);
    });
  });

  describe("renderStatus", () => {
    function info(overrides: Partial<CorpusInfoDto> = {}): CorpusInfoDto {
      return {
        ...ENVELOPE,
        kind: "corpus_info",
        name: "demo",
        path: "/tmp/demo/corpus.sqlite3",
        scope: "project",
        corpus_schema_version: "1",
        embedding: { id: "hash-v1:d256", semantic: false },
        chunking: {},
        counts: { documents: 3, chunks: 4, vectors: 4, nodes: 5, edges: 10, failures: 0, exclusions: 0 },
        freshness: { status: "current", built_at: "2026-09-14T00:00:00.000Z", source_revisions: {}, reason: null },
        sources: [{ id: "docs", kind: "local", uri: "/tmp/demo/docs", revision: null, document_count: 3 }],
        compatible: true,
        incompatibility: null,
        warnings: [],
        ...overrides,
      };
    }

    it("shows counts and freshness", () => {
      const output = renderStatus(info(), plain);
      assert.match(output, /documents {3}3/);
      assert.match(output, /freshness {3}current/);
    });

    it("says clearly when a corpus cannot be searched, and why", () => {
      const output = renderStatus(
        info({ compatible: false, incompatibility: "embedding identity changed" }),
        plain,
      );
      assert.match(output, /compatible {2}no/);
      assert.match(output, /embedding identity changed/);
    });

    it("marks the built-in embedder as lexical", () => {
      assert.match(renderStatus(info(), plain), /\(lexical\)/);
    });

    it("lists sources with their document counts", () => {
      assert.match(renderStatus(info(), plain), /docs {13}local {2}3 doc\(s\)/);
    });

    it("surfaces failures rather than burying them", () => {
      const output = renderStatus(
        info({ counts: { ...info().counts, failures: 2 } }),
        plain,
      );
      assert.match(output, /failures {4}2/);
    });
  });

  describe("renderCorpusList", () => {
    function list(overrides: Partial<CorpusListDto> = {}): CorpusListDto {
      return {
        ...ENVELOPE,
        kind: "corpus_list",
        corpora: [
          {
            name: "demo",
            scope: "project",
            path: "/tmp/demo",
            document_count: 3,
            chunk_count: 4,
            built_at: null,
            compatible: true,
            description: "the demo corpus",
          },
        ],
        warnings: [],
        ...overrides,
      };
    }

    it("lists each corpus with its counts", () => {
      const output = renderCorpusList(list(), plain);
      assert.match(output, /demo/);
      assert.match(output, /3 doc/);
      assert.match(output, /the demo corpus/);
    });

    it("points at init when there is nothing", () => {
      assert.match(renderCorpusList(list({ corpora: [] }), plain), /graphdog init/);
    });

    it("flags an incompatible corpus in the list", () => {
      const output = renderCorpusList(
        list({ corpora: [{ ...list().corpora[0]!, compatible: false }] }),
        plain,
      );
      assert.match(output, /\[incompatible\]/);
    });
  });

  describe("renderBuildReport", () => {
    function report(overrides: Partial<BuildReportDto> = {}): BuildReportDto {
      return {
        ...ENVELOPE,
        kind: "build_report",
        corpus: "demo",
        status: "ok",
        documents: { added: 3, modified: 0, deleted: 0, unchanged: 0 },
        chunks: 4,
        nodes: 5,
        edges: 10,
        failures: [],
        exclusions: [],
        elapsed_seconds: 0.021,
        warnings: [],
        ...overrides,
      };
    }

    it("summarizes what changed", () => {
      const output = renderBuildReport(report(), plain);
      assert.match(output, /ok/);
      assert.match(output, /3 added, 0 modified/);
      assert.match(output, /4 chunk\(s\)/);
    });

    it("lists failures with their reason", () => {
      const output = renderBuildReport(
        report({
          status: "partial",
          failures: [
            { ref: "docs/bad.pdf", stage: "extract", code: "extraction_failed", message: "no text layer", at: "x" },
          ],
        }),
        plain,
      );
      assert.match(output, /partial/);
      assert.match(output, /docs\/bad\.pdf: no text layer/);
    });

    it("elides a very long failure list but says how many were hidden", () => {
      const failures = Array.from({ length: 25 }, (_, i) => ({
        ref: `docs/f${i}.pdf`,
        stage: "extract",
        code: "extraction_failed",
        message: "nope",
        at: "x",
      }));
      const output = renderBuildReport(report({ status: "partial", failures }), plain);
      assert.match(output, /and 15 more/);
    });

    it("mentions skipped secrets without listing them", () => {
      const output = renderBuildReport(
        report({ exclusions: [{ ref: "docs/.env", reason: "secret_pattern", details: {} }] }),
        plain,
      );
      assert.match(output, /1 file\(s\) skipped as secrets/);
      assert.doesNotMatch(output, /\.env/, "a secret's name should not be echoed by default");
    });
  });

  describe("renderWarnings", () => {
    it("returns nothing for no warnings", () => {
      assert.deepEqual(renderWarnings([], plain), []);
    });

    it("prefixes each warning so it stands out", () => {
      const lines = renderWarnings([{ code: "x", message: "careful", details: {} }], plain);
      assert.ok(lines.some((line) => line.includes("! careful")));
    });
  });

  describe("renderError", () => {
    it("shows the code and message", () => {
      assert.match(renderError("not_found", "no such thing", {}, plain), /error \[not_found\]: no such thing/);
    });

    it("shows a hint when the error carries one", () => {
      assert.match(renderError("x", "y", { hint: "try this" }, plain), /hint: try this/);
    });

    it("shows a remedy command when the error carries one", () => {
      assert.match(renderError("x", "y", { remedy: "graphdog build --full" }, plain), /try: graphdog build --full/);
    });

    it("lists available options when the error carries them", () => {
      assert.match(renderError("x", "y", { available: ["a", "b"] }, plain), /available: a, b/);
    });
  });
});

describe("cli/infrastructure/render/humanRenderer: several corpora", () => {
  function multi(): SearchResponseDto {
    return {
      ...search(),
      corpus: "auth, ops",
      corpora: [
        { name: "auth", scope: "project", embedding_id: "hash-v1:d256", hits: 1, searched: true, skipped_reason: null },
        { name: "ops", scope: "home", embedding_id: "hash-v1:d256", hits: 1, searched: true, skipped_reason: null },
      ],
      hits: [
        hit({ corpus: "auth", corpus_rank: 1, title: "Access Token" }),
        hit({ corpus: "ops", corpus_rank: 1, title: "Runbook", ref: "ops/runbook.md", read_ref: "ops/runbook.md#L1-L5" }),
      ],
    };
  }

  it("labels each hit with its corpus", () => {
    const output = renderSearch(multi(), plain);
    assert.match(output, /\[auth\]/);
    assert.match(output, /\[ops\]/);
  });

  it("shows each hit's rank within its own corpus", () => {
    // "second overall but best in its corpus" is the distinction that matters
    // when reading a merged list.
    assert.match(renderSearch(multi(), plain), /#1 in ops/);
  });

  it("does not label hits when only one corpus was searched", () => {
    const output = renderSearch(search(), plain);
    assert.doesNotMatch(output, /\[demo\]/, "the label would be identical on every line");
  });

  it("names corpora that were skipped, so a smaller answer is visible", () => {
    const response = multi();
    const withSkip: SearchResponseDto = {
      ...response,
      corpora: [
        ...response.corpora,
        { name: "archive", scope: "home", embedding_id: null, hits: 0, searched: false, skipped_reason: "not built" },
      ],
    };
    assert.match(renderSearch(withSkip, plain), /Not searched: archive/);
  });
});

// --- evaluation --------------------------------------------------------------

function evaluation(overrides: Partial<EvaluationReportDto> = {}): EvaluationReportDto {
  return {
    ...ENVELOPE,
    kind: "evaluation_report",
    dataset: "auth",
    corpus: "demo",
    embedding_id: "hashing:v1:d256",
    k: 10,
    strategy: { fusion: "rrf" },
    summary: {
      queries: 4,
      measured: 4,
      recall_at_k: 0.75,
      precision_at_k: 0.1,
      mrr: 0.625,
      ndcg_at_k: 0.6,
      evidence_accuracy: 1,
      evidence_checked: 2,
      zero_result_queries: 0,
      missed_queries: 1,
      failed_queries: 0,
      latency: { mean_ms: 4.2, p50_ms: 4, p95_ms: 9, max_ms: 9 },
    },
    queries: [
      {
        id: "jwks",
        query: "JWKS",
        note: null,
        metrics: {
          recall_at_k: 1,
          precision_at_k: 0.1,
          reciprocal_rank: 1,
          ndcg_at_k: 1,
          evidence_checked: 1,
          evidence_correct: 1,
          evidence_accuracy: 1,
          retrieved: 2,
          relevant: 1,
        },
        elapsed_ms: 4,
        retrieved_refs: ["docs/keys.md"],
        missing_refs: [],
        error: null,
      },
      {
        id: "lunch",
        query: "cafeteria",
        note: null,
        metrics: {
          recall_at_k: 0,
          precision_at_k: 0,
          reciprocal_rank: 0,
          ndcg_at_k: 0,
          evidence_checked: 0,
          evidence_correct: 0,
          evidence_accuracy: null,
          retrieved: 1,
          relevant: 1,
        },
        elapsed_ms: 9,
        retrieved_refs: ["docs/token.md"],
        missing_refs: ["docs/menu.md"],
        error: null,
      },
    ],
    comparison: null,
    status: "ok",
    gate_failures: [],
    warnings: [],
    ...overrides,
  };
}

describe("cli/infrastructure/render/humanRenderer: renderEvaluation", () => {
  it("names the dataset, the corpus and the embedding that produced the numbers", () => {
    const output = renderEvaluation(evaluation(), plain);
    assert.match(output, /auth/);
    assert.match(output, /demo/);
    assert.match(output, /hashing:v1:d256/);
  });

  it("labels the @K metrics with the cutoff they were computed at", () => {
    const output = renderEvaluation(evaluation(), plain);
    assert.match(output, /recall@10\s+0\.750/);
    assert.match(output, /ndcg@10\s+0\.600/);
  });

  it("prints an unmeasurable metric as -- rather than as zero", () => {
    const report = evaluation();
    const output = renderEvaluation(
      { ...report, summary: { ...report.summary, recall_at_k: null } },
      plain,
    );
    assert.match(output, /recall@10\s+--/);
  });

  it("says when no spans were judged instead of printing an evidence score", () => {
    const report = evaluation();
    const output = renderEvaluation(
      { ...report, summary: { ...report.summary, evidence_checked: 0, evidence_accuracy: null } },
      plain,
    );
    assert.match(output, /no spans judged/);
  });

  it("reports latency percentiles", () => {
    assert.match(renderEvaluation(evaluation(), plain), /p50 4ms\s+p95 9ms/);
  });

  it("lists the weakest queries, which is where a regression is diagnosed", () => {
    const output = renderEvaluation(evaluation(), plain);
    assert.match(output, /weakest queries/);
    assert.match(output, /lunch\s+not found/);
    assert.match(output, /missing: docs\/menu\.md/);
  });

  it("does not list a query the search answered perfectly", () => {
    const output = renderEvaluation(evaluation(), plain);
    const weakest = output.slice(output.indexOf("weakest queries"));
    assert.doesNotMatch(weakest, /jwks/);
  });

  it("omits the weakest-query section when every query was answered first", () => {
    const report = evaluation();
    const output = renderEvaluation(
      { ...report, queries: [report.queries[0] as EvaluationReportDto["queries"][number]] },
      plain,
    );
    assert.doesNotMatch(output, /weakest queries/);
  });

  it("shows a query that errored, distinct from one that simply missed", () => {
    const report = evaluation();
    const failed = { ...(report.queries[1] as EvaluationReportDto["queries"][number]), error: "index corrupted" };
    const output = renderEvaluation({ ...report, queries: [failed] }, plain);
    assert.match(output, /error: index corrupted/);
  });

  it("shows the rank of a query that found its answer late", () => {
    const report = evaluation();
    const late = {
      ...(report.queries[1] as EvaluationReportDto["queries"][number]),
      metrics: { ...(report.queries[1] as EvaluationReportDto["queries"][number]).metrics, reciprocal_rank: 0.25 },
    };
    assert.match(renderEvaluation({ ...report, queries: [late] }, plain), /rank 4/);
  });

  it("shows a delta beside each metric when a baseline was compared", () => {
    const output = renderEvaluation(
      evaluation({
        comparison: [
          { metric: "recall", baseline: 0.5, current: 0.75, delta: 0.25 },
          { metric: "mrr", baseline: 0.7, current: 0.625, delta: -0.075 },
        ],
      }),
      plain,
    );
    assert.match(output, /recall@10\s+0\.750\s+\+0\.250/);
    assert.match(output, /mrr\s+0\.625\s+-0\.075/);
  });

  it("confirms explicitly when a baseline comparison found no regression", () => {
    const output = renderEvaluation(evaluation({ comparison: [] }), plain);
    assert.match(output, /no regression against the baseline/);
  });

  it("stays silent about regressions when no baseline was given", () => {
    assert.doesNotMatch(renderEvaluation(evaluation(), plain), /baseline/);
  });

  it("spells out every breached gate", () => {
    const output = renderEvaluation(
      evaluation({
        status: "failed",
        gate_failures: [
          {
            kind: "threshold",
            metric: "recall",
            observed: 0.75,
            required: 0.9,
            message: "recall 0.750 is below the required 0.900",
          },
        ],
      }),
      plain,
    );
    assert.match(output, /gate failed/);
    assert.match(output, /recall 0\.750 is below the required 0\.900/);
  });

  it("carries warnings through", () => {
    const output = renderEvaluation(
      evaluation({ warnings: [{ code: "eval_unknown_ref", message: "2 judged ref(s) are not in this corpus", details: {} }] }),
      plain,
    );
    assert.match(output, /not in this corpus/);
  });
});

// --- archives ----------------------------------------------------------------

function archiveReport(overrides: Partial<ArchiveReportDto> = {}): ArchiveReportDto {
  return {
    ...ENVELOPE,
    kind: "archive_report",
    operation: "export",
    corpus: "docs",
    archive_path: "/work/docs.gdog",
    bytes: 20480,
    checksum: "a".repeat(64),
    destination: null,
    manifest: {
      format_version: 1,
      corpus: "docs",
      created_at: "2026-09-15T12:00:00.000Z",
      created_by: "graphdog 0.1.0",
      built_at: "2026-09-14T00:00:00.000Z",
      identity: {
        schema_version: "1",
        chunking_schema_version: "1",
        embedding_id: "hash-v1:d256",
        chunking_fingerprint: "chunk1:0123456789abcdef",
      },
      counts: { documents: 4, chunks: 57, nodes: 5, edges: 10 },
      sources: [
        { id: "docs", revision: null },
        { id: "spec", revision: "a1b2c3d4e5f60718293a4b5c" },
      ],
    },
    warnings: [],
    ...overrides,
  };
}

const imported = (overrides: Partial<ArchiveReportDto> = {}): ArchiveReportDto =>
  archiveReport({
    operation: "import",
    destination: { path: "/home/u/.graphdog/corpora/docs", scope: "home", replaced: false },
    ...overrides,
  });

describe("cli/infrastructure/render/humanRenderer: renderArchiveReport", () => {
  it("says what was exported, where to, and how large it is", () => {
    const output = renderArchiveReport(archiveReport(), plain);
    assert.match(output, /^exported docs to \/work\/docs\.gdog \(20 KB\)/);
  });

  it("formats sizes to recognisable precision", () => {
    assert.match(renderArchiveReport(archiveReport({ bytes: 1536 }), plain), /\(1\.5 KB\)/);
    assert.match(renderArchiveReport(archiveReport({ bytes: 512 }), plain), /\(512 B\)/);
    assert.match(renderArchiveReport(archiveReport({ bytes: 3 * 1024 ** 2 }), plain), /\(3\.0 MB\)/);
  });

  it("always shows the checksum, which is how a copy is checked", () => {
    assert.match(renderArchiveReport(archiveReport(), plain), new RegExp(`sha256 ${"a".repeat(64)}`));
  });

  it("describes the corpus: counts, build time and embedding", () => {
    const output = renderArchiveReport(archiveReport(), plain);
    assert.match(output, /4 document\(s\), 57 chunk\(s\), 5 node\(s\), 10 edge\(s\)/);
    assert.match(output, /built 2026-09-14T00:00:00\.000Z with hash-v1:d256/);
  });

  it("lists sources with short revisions, so provenance is visible at a glance", () => {
    assert.match(renderArchiveReport(archiveReport(), plain), /sources docs, spec@a1b2c3d4e5f6\n/);
  });

  it("says where an import landed and which workspace that is", () => {
    const output = renderArchiveReport(imported(), plain);
    assert.match(output, /^imported docs from \/work\/docs\.gdog/);
    assert.match(output, /into \/home\/u\/\.graphdog\/corpora\/docs \(home workspace\)/);
  });

  it("shows the new name when an import was renamed", () => {
    const output = renderArchiveReport(imported({ corpus: "team-docs" }), plain);
    assert.match(output, /^imported docs as team-docs from/);
    assert.match(output, /--corpus team-docs/);
  });

  it("says replaced rather than imported when it overwrote a corpus", () => {
    const output = renderArchiveReport(
      imported({ destination: { path: "/p", scope: "project", replaced: true } }),
      plain,
    );
    assert.match(output, /^replaced docs from/);
  });

  it("tells an importer how to use what they just imported", () => {
    assert.match(renderArchiveReport(imported(), plain), /graphdog search "<query>" --corpus docs/);
  });

  it("does not claim verification for an export", () => {
    assert.doesNotMatch(renderArchiveReport(archiveReport(), plain), /verified/);
  });

  it("carries warnings through", () => {
    const output = renderArchiveReport(
      imported({ warnings: [{ code: "corpus_shadowed", message: "a project corpus takes precedence", details: {} }] }),
      plain,
    );
    assert.match(output, /! a project corpus takes precedence/);
  });
});
