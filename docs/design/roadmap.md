# Roadmap

What exists, what does not, and what was deliberately deferred -- and what
GraphDog takes from Graphify, the nearest widely used tool: its shape as a
product and the way it is installed, not its feature list.

## Built

- Domain: tokenization, chunking with exact locations, BM25, fusion, graph
  construction and expansion, link resolution, snippet selection
- Use cases: build, incremental update, search, explore, read, describe
- Storage: single-file SQLite corpus with atomic builds
- Sources: local folders, git working trees (revision-aware, `.gitignore`-honest)
- Extraction: Markdown, plain text, source code; PDF and DOCX behind optional deps
- Embedding: built-in lexical hashing; local ONNX semantic models opt-in
- Reranking: cross-encoder, opt-in, degrades to a warning when unavailable
- Multi-corpus search: `--corpus` repeated or `--all`, merged by rank across corpora
- Evaluation harness: judged datasets, IR metrics, baselines and a CI regression gate
- Portable archives: `export` and `import` of a verified `.gdog` file
- CLI: `init`, `add`, `build`, `update`, `search`, `explore`, `read`, `status`, `list`, `eval`,
  `export`, `import`
- MCP: `search`, `explore`, `read`, `status`, `list_corpora`, `build_corpus` (write-gated)
- Compatibility gate, freshness reporting, auditable exclusions and failures
- 1290+ tests, every source file with a colocated spec

## What to take from Graphify

[Graphify](https://github.com/Graphify-Labs/graphify) (formerly
`safishamsi/graphify`) is the closest widely used tool: a skill for coding
agents that turns a folder into a knowledge graph. Everything said about it here
comes from its README as of September 2026.

GraphDog is not trying to become Graphify. The two answer different questions.
Graphify maps **structure** -- which symbols and concepts connect -- and uses an
LLM for everything that is not code. GraphDog finds **evidence** -- where exactly
something is stated, verbatim, with a line range a reader can check -- and uses
no model unless asked. Code structure in particular is served better by tools
built for it, such as code-review-graph or Graphify's own AST pass; GraphDog sits
beside them rather than competing.

What is worth copying is the product shape: one install, one command to connect
an agent, a plain account of what was set up, and an uninstall that takes all of
it back. That is item 2 below, designed in [Distribution and
lifecycle](distribution.md).

| | Graphify | GraphDog today | For the roadmap |
|---|---|---|---|
| **Install** | `uv tool install graphifyy`, then `graphify install` or `graphify <platform> install`, for the user or `--project` | `npm install -g graphdog`; the MCP config written by hand, pointing at `npx` | **Adopt the shape**, on Homebrew: `brew install`, then `graphdog install --platform <name>` |
| **Upgrade** | `uv tool upgrade graphifyy`, then `graphify install` again | `npm update -g graphdog` | `brew upgrade graphdog`; `graphdog doctor` flags integrations an older version wrote |
| **Uninstall** | `graphify uninstall`, per-platform variants, `graphify hook uninstall`; `--purge` also deletes the generated output, which is otherwise kept | nothing to undo but the npm package | **Adopt**: `graphdog uninstall`, with `--purge` for data, driven by a record of what was written |
| **What is installed** | `graphify hook status`; no single command for the rest | nothing | **Improve on it**: `graphdog doctor` |
| **Agent integration** | per-platform instruction files and hooks that steer the agent to the graph; a strict mode that blocks the first read | an MCP server | MCP registration plus instructions, for Claude Code, GitHub Copilot and Kiro first; steer, never block |
| **Code** | tree-sitter AST, 37 languages; `calls`, `imports`, `inherits` edges; no LLM | indexed as text chunks | **Leave to code-graph tools**; an optional adapter at most |
| **Docs, PDFs, images** | an LLM extracts concepts and relations; audio and video transcribed locally | Markdown, text and code; PDF and DOCX behind optional deps | local OCR and transcription, optional; LLM enrichment opt-in only |
| **Orientation** | a report of hub nodes, cross-module links and suggested questions; Leiden communities named by an LLM | `explore` (the graph neighbourhood around a query's hits), `suggested_queries` (from tags and headings), `status` (counts, freshness). No query-free overview, and no model anywhere in it | **Later, and small**: hub documents and top tags in `status` |
| **Edge provenance** | every edge `EXTRACTED`, `INFERRED` or `AMBIGUOUS` | every edge explained in a phrase but unlabelled -- although `similar` edges are computed, which is to say inferred | **Adopt** |
| **Citations** | file and line for code nodes | an exact line range on every hit, verbatim through `read` | GraphDog's reason to exist; the rule for everything new |
| **Keeping current** | cache, `--update`, `watch`, git hooks, a merge driver for the committed `graph.json` | incremental `update`, freshness reporting, compatibility gate | **Later**: a post-commit hook, installed and removed like any integration; no merge driver, since the index is never committed |
| **Views and exports** | interactive HTML, Obsidian, GraphML, Neo4j, SVG, a wiki | none | **Later**: read-only exports of the store |
| **Evaluation** | public benchmarks (LOCOMO n=300, LongMemEval-S n=50): recall and end-to-end QA accuracy, QA scored by an LLM judge validated against a second judge (90.6% agreement, kappa 0.81) | 15 hand-judged queries over its own docs; retrieval and citation metrics; a CI gate | **Both kinds are needed** -- item 1 |
| **Privacy** | code stays local; other inputs go to the configured LLM backend unless that backend is local | nothing leaves the machine; the optional ONNX models embed and rerank text locally, and none of them generates any | keep |

## Next

Items 1 and 2 are independent and can proceed in parallel. Everything after them
is a ranking or graph change, and lands with a before-and-after from item 1.

### 1. Evaluation: a dataset that can tell a change from noise

**The gate has moved to a frozen, external suite.** CI now gates on
`allganize-ja` (see [its README](../../eval/suites/allganize-ja/README.md)):
ten Japanese government PDFs, committed and pinned by SHA-256, with 54
questions written by Allganize rather than by GraphDog's authors, each judged by
the page that answers it. Documents were chosen by a stated rule, never by
results. GraphDog's own docs remain a suite that reports but does not gate.

Building it found three things before a single number was trusted:

- **PDF extraction was broken outright.** pdfjs-dist 6 removed
  `PDFDocumentProxy.destroy()`, which GraphDog called on every PDF, so every
  PDF failed. Teardown now goes through the loading task.
- **Japanese PDFs in CID fonts came out nearly empty.** Without pdf.js's
  character maps one ministry guideline yielded 17 Japanese characters instead
  of 7,301. The maps are now passed in, with a test that proves the fixture
  needs them.
- **Recall@10 measures nothing on ten documents**: every document is in the top
  ten. The suite is scored at k=3, and page-level evidence carries most of the
  signal.

What the first list below still describes is the report-only docs suite; for
the gate, the corpus no longer moves, the questions are not self-written,
evidence is judged by page, and the queries are Japanese. At 54 queries, one
rank slipping from 1 to 2 moves MRR by 0.009, inside the gate's tolerance.
Still open: no-answer queries, graph and cross-corpus suites, scale, confidence
intervals, and any semantic-embedder measurement.

What the original dataset could not carry:

- **Too small to resolve anything.** With 15 queries, one query slipping from
  rank 1 to rank 2 moves MRR by 0.033 -- three times the gate's tolerance. The
  gate flags noise, and real differences of a few hundredths are invisible.
- **The corpus moves under it.** The corpus is GraphDog's own docs, so editing
  the docs moves the numbers: adding the archive docs raised MRR from 0.577 to
  0.601 with no retrieval change at all. A regression gate should measure code,
  not prose.
- **Circular.** One person wrote the documents, the queries and the judgments, so
  the queries echo the documents' wording. Paraphrase -- the known weakness -- is
  under-represented by construction.
- **Blind spots.**
  - No Japanese query, though CJK search is a headline feature.
  - No query whose answer is absent. What agents rely on most -- saying "not in
    the corpus" (exit 7) instead of returning the least-bad row -- is not measured
    at all, because the harness treats a query with no judgments as
    unmeasurable.
  - No query that needs the graph, so nothing shows the graph signal earns its
    place.
  - One corpus at a time, so the cross-corpus merge is unmeasured.
  - Evidence judged at section granularity only.
  - Latency measured on four documents; indexing throughput, which the original
    handoff asked for, not at all.

Graphify's evaluation sits at the other extreme: public benchmarks, comparable
across systems, but chosen for conversational memory and scored partly by an LLM
judge -- they say little about citation precision on a document corpus. GraphDog
needs its own precise metrics on suites broad enough to mean something, plus a
few public sets for comparability.

**Suites.** Each is a dataset plus a *pinned* corpus, and every query carries a
category.

| Suite | Corpus | Measures | When |
|---|---|---|---|
| `graphdog-docs`, frozen | a snapshot of `docs/design/` versioned under `eval/corpora/`; the live docs become a report that does not gate | regressions, independent of doc edits | first |
| no-answer | the same corpora, with queries whose answer is absent | abstention on unanswerable queries and false abstention on answerable ones; the evidence for `min_score` | first |
| Japanese | a subset of a public Japanese retrieval set (MIRACL-ja, JQaRA or JaCWIR, licence permitting) plus hand-written queries over Japanese technical docs | bigrams against `kuromoji`; lexical against semantic on CJK | second |
| public English | small BEIR sets (SciFact, NFCorpus) | the BM25 implementation against published BM25 baselines; lexical, semantic and rerank against each other | second |
| real work | a corpus people actually search, with queries harvested from the predecessor's use and judged by the documents' owners | the defaults, on the workload they exist for; private, run locally | as soon as one is available |
| graph | a linked Markdown wiki, with multi-hop questions whose answer is *linked from* what the query matches rather than similar to it | graph expansion at 0 hops against 2: whether the graph signal helps | with any graph change |
| code | docstring-to-function queries in the style of CodeSearchNet, over a few repositories | whether an optional code adapter improves citations into source files | only if that adapter is built |
| cross-corpus | one suite's judgments split across two or three corpora, one of them with a different embedding | the rank merge against a single combined corpus | with the harness changes below |
| scale | synthetic corpora of 1k, 10k and 100k documents | build throughput, index size, p50 and p95 latency; where exhaustive vector scan stops being enough | before any ANN work |

Public sets are downloaded by a script at evaluation time and never vendored, and
each licence is checked before its suite is added.

**Harness changes** the suites need:

- a `category` per query (lexical, paraphrase, multi-hop, no-answer, Japanese,
  code) and a per-category breakdown, since an aggregate hides that paraphrase is
  the weak spot
- queries marked `"expect": "no_answer"`, scored by whether search abstained
  rather than skipped as unmeasurable
- datasets that name several corpora, for the cross-corpus suite
- a configuration matrix -- embedding by rerank by hops -- in one run and one table
- confidence intervals from paired resampling over queries, so a delta inside
  the noise is labelled as noise rather than gated on
- **tokens to evidence**: how much text an agent must read to reach the judged
  span -- snippet plus `read` range, against reading whole files. It is the
  framing Graphify leads with, and GraphDog can measure it exactly.
- pooled judging: run several configurations, collect their top results, and
  judge whatever nobody has judged yet. An LLM may propose judgments offline to
  make this affordable, but only with its agreement against human judgments
  measured and published on a sample, as Graphify does for its judge. It never
  runs at build or query time.
- a development and a test split per suite, so tuning happens on one half and is
  reported on the other

No suite's numbers change a default until it has on the order of 50 queries.

### 2. Distribution and lifecycle: Homebrew, and an uninstall that leaves nothing behind

Designed in [Distribution and lifecycle](distribution.md). In short:

- **Homebrew first**, from the tap `4moda/homebrew-graphdog` (`brew install 4moda/graphdog/graphdog`) and in
  homebrew-core once GraphDog meets its acceptance policy. Upgrade and removal
  are `brew upgrade` and `brew uninstall`. npm remains for Windows without WSL
  and for CI.
- **One install gives the CLI and the MCP server**: the `graphdog` package
  depends on `@graphdog/mcp` and exposes it as `graphdog mcp`. The packages stay
  separate.
- **`graphdog install --platform <claude|copilot|kiro> [--project]`** registers
  the MCP server -- the installed binary, never `npx` -- and adds GraphDog's
  instructions: its own file where the platform reads several (Copilot, Kiro), a
  marker-delimited block where it reads one (Claude Code's `CLAUDE.md`).
- **`graphdog uninstall [--purge]`** removes exactly what a ledger says was
  written. Homebrew cannot do this part: `brew uninstall` removes only what it
  installed, and `--zap` is for casks.
- **`graphdog doctor`** reports everything installed and anything broken,
  including integrations written by an older version and corpora this version
  cannot read.
- **Extras and model caches move out of the install directory**, so a
  `brew upgrade` does not silently drop semantic search.

### 3. Ranking work the harness has already identified

The harness's first finding was a defect: graph expansion gave every chunk of a
reached document the same score, so one graph claim became forty tied candidates
that RRF ordered by chunk id. Fixing it -- one representative chunk per document
-- moved every metric on the built-in dataset at once:

| | before | after |
|---|---|---|
| recall@10 | 0.762 | **1.000** |
| precision@10 | 0.114 | **0.150** |
| MRR | 0.536 | **0.577** |
| nDCG@10 | 0.536 | **0.632** |
| queries that missed entirely | 2 | **0** |

What the dataset still shows, now at 15 queries:

- **MRR is 0.63 with the lexical default.** The right document is reliably found
  and often not first -- including for `read_ref line range`, which names a field
  verbatim. An exact-term query should not need four results.
- **Citations miss on paraphrase.** Evidence accuracy is 0.625. The paraphrase
  query added with the archive docs finds all three judged documents and cites
  the wrong section in each.
- **Precision@10 is 0.16.** Partly an artifact of four documents and a divisor
  of ten, but also fusion returning a full page when two results would do.
- **No semantic measurement.** Every number is the hashing embedder.

On the gating suite (`allganize-ja`, k=3) the weak spots are different, and
they are the ones to work on:

- **Answers inside images.** MRR 0.656 and page-level evidence 0.714 for
  questions whose answer sits in a figure, against 0.853 and 0.800 for
  paragraphs. Text extraction cannot see an image; this is the gap OCR would
  close, and it is now measured.
- **Retail citations.** Page-level evidence 0.600: the right document, the
  wrong page, four times in ten.
- **Below plain BM25 on SciFact.** A trial on the public SciFact set scored
  nDCG@10 0.559 with the default fused pipeline, against 0.665 published for
  BM25 alone. Whether fusion with the hashing embedder and the graph drags BM25
  down, or GraphDog's BM25 differs from the standard one, is not yet known.

Each is re-measured before anyone acts on it.

### 4. Edge provenance

Label every edge `extracted` -- written in the source: a link, a tag, a
directory, and later a call -- or `inferred` -- computed: `similar` edges today,
anything an enrichment stage adds tomorrow -- with a confidence for the inferred
ones. `similar` edges are already inferred, and nothing in the output says so.
An additive contract change to `graph_path`; cheap now, and it has to exist
before any model-derived edge does.

## Later

- **Orientation in `status`** -- hub documents (the most linked), the commonest
  tags and each source's size, so an agent meeting a corpus for the first time
  sees what is in it before it knows what to search for. Deterministic, from the
  graph that already exists; community detection only if the graph suite shows
  it adds something these do not.
- **`path <ref> <ref>`** -- the chain of edges connecting two documents, each with
  the span that created it.
- **An optional code adapter** -- so a hit in a source file can cite a whole
  function: either by reading symbol spans from a code-graph tool such as
  code-review-graph, or through an optional tree-sitter chunker. Never required,
  and never a call graph of GraphDog's own: code structure is those tools' job.
- **Keeping the index current unasked** -- `graphdog watch`, and a post-commit
  and post-checkout hook that runs `update`, installed and removed through the
  same ledger as any integration.
- **Opt-in LLM enrichment** -- concept nodes, inferred edges and community names
  from a configured model, as a separate build stage (this absorbs "query
  expansion and optional LLM summarization"). Recorded in the corpus identity the
  way the embedding model is, labelled `inferred`, every edge citing the spans it
  came from, and kept out of ranking unless enabled. The no-LLM-required
  guarantee stays.
- **Other package managers** -- winget or Scoop for Windows without WSL, if npm
  proves awkward there.
- **Local media** -- images through local OCR, audio and video through a local
  speech model, behind optional dependencies. Needs locations beyond lines: page
  regions and timestamps.
- **Read-only exports** -- GraphML and a self-contained HTML view of the graph,
  for people working out why something was or was not found. Exports only;
  GraphML as the canonical store stays rejected.
- **Registry distribution** -- OCI artifacts, GitHub Packages, GitLab Generic
  Package Registry, in that order of preference. Wants signature verification:
  `.gdog` archives already carry checksums, which prove an archive is intact but
  not who made it.
- **More sources** -- Confluence, GitLab wikis and issues, SharePoint, and a
  connector SDK so adapters live outside this repository.
- **Morphological Japanese tokenization** -- `kuromoji` behind the existing
  tokenizer interface, as an opt-in alternative to bigrams, decided by the
  Japanese suite: bigrams over-generate slightly but never miss domain vocabulary
  a dictionary has not seen.
- **ANN vector backend** -- behind the existing `VectorIndex` port, once the scale
  suite shows exhaustive scan is the bottleneck.

## Not planned

- **A chat UI.** This is search infrastructure. Something else can build a UI on
  the contract.
- **A required LLM.** Building and searching stays fully local and offline.
- **Reimplementing code intelligence.** Call graphs and symbol navigation belong
  to code-graph tools. GraphDog indexes documents and cites them.
- **An LLM-built graph by default.** Graphify's graph of everything that is not
  code comes from a model. GraphDog's default graph stays deterministic and
  reproducible; model-derived structure stays opt-in and labelled.
- **Structure without evidence.** No node, edge, community or path is returned
  without the spans that justify it.
- **Blocking reads.** GraphDog is consulted, not a gatekeeper: no hook that stops
  an agent from reading a file.
- **A committed index.** Commit the config and rebuild; move an index with an
  archive.
- **A server mode.** A corpus is a file; the MCP server is a process, not a
  service to operate.
