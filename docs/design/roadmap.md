# Roadmap

What exists, what does not, and what was deliberately deferred -- and how that
compares with Graphify, the nearest widely used tool.

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

## Next to Graphify

[Graphify](https://github.com/Graphify-Labs/graphify) (formerly
`safishamsi/graphify`) is the closest widely used tool: a skill for coding
agents that turns a folder into a knowledge graph. Everything said about it here
comes from its README as of September 2026.

The two answer different questions. Graphify maps **structure** -- which
functions, modules and concepts connect, and through what. GraphDog finds
**evidence** -- where exactly something is stated, verbatim, with a line range a
reader can check. Graphify builds its graph from code deterministically but uses
an LLM for everything else; GraphDog uses none unless asked.

| | Graphify | GraphDog | For the roadmap |
|---|---|---|---|
| **Code** | tree-sitter AST, 37 languages; `calls`, `imports`, `inherits` edges; no LLM | indexed as text chunks; no symbols, no call graph | **Adopt** -- the same deterministic extraction fits every GraphDog constraint |
| **Docs, PDFs, images** | an LLM extracts concepts and relations; audio and video transcribed locally with faster-whisper | Markdown, text and code; PDF and DOCX behind optional deps; no images or audio | **Partly** -- local OCR and transcription behind optional deps; LLM extraction only as opt-in enrichment |
| **Graph unit** | concepts and symbols | documents, with tag and directory waypoints | **Add** symbol nodes; keep documents as the anchors evidence hangs from |
| **Edge provenance** | every edge `EXTRACTED`, `INFERRED` or `AMBIGUOUS` | every edge explained in a phrase, but unlabelled -- although `similar` edges are computed, which is to say inferred | **Adopt now**, before more inferred edges exist |
| **Orientation** | Leiden communities, named by an LLM; a report of hub ("god") nodes, cross-module connections and suggested questions | `explore` neighbourhoods; `suggested_queries` from tags and headings | **Adopt** a deterministic `overview`: communities, hubs and bridges, named from titles and tags |
| **Queries** | `query` (a subgraph), `path A B`, `explain`; MCP `query_graph`, `get_node`, `get_neighbors`, `shortest_path` | `search`, `explore`, `read`; per-signal scores; exit 7 when nothing qualifies | **Adopt** `path`, returned with the span that justifies each edge |
| **Citations** | file and line for code nodes | an exact line range on every hit, verbatim through `read` | GraphDog's reason to exist; the rule for everything new |
| **Retrieval** | graph traversal; no vector store | dense + BM25 + graph, fused by rank, optional rerank | -- |
| **Keeping current** | cache, `--update`, `watch`, git hooks, a merge driver for the committed `graph.json` | incremental `update`, freshness reporting, compatibility gate | **Adopt** `watch` and a post-commit hook; no merge driver, since the index is derived and never committed |
| **Agent integration** | installers for 20+ platforms; hooks that steer agents to the graph before reading files, and a strict mode that blocks the first read | npm CLI and MCP server | **Adopt** installers for a few platforms; steer, never block |
| **Views and exports** | interactive HTML, Obsidian, GraphML, Neo4j, SVG, a wiki | none | **Later** -- read-only exports of the store |
| **Evaluation** | public benchmarks (LOCOMO n=300, LongMemEval-S n=50): recall and end-to-end QA accuracy, QA scored by an LLM judge validated against a second judge (90.6% agreement, kappa 0.81) | 15 hand-judged queries over its own docs; retrieval and citation metrics; a CI gate | **Both kinds are needed** -- see *Evaluation* below |
| **Privacy** | code stays local; other inputs go to the configured LLM backend unless that backend is local | nothing leaves the machine; optional models run locally | keep |

The comparison says as much about what GraphDog should not become as about what
it should borrow; see *Not planned*.

## Next

In order. The first item comes first because every item after it is a ranking or
graph change, and each has to land with a before-and-after it can be judged by.

### 1. Evaluation: a dataset that can tell a change from noise

The current dataset cannot carry that weight:

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
| graph | a linked Markdown wiki, with multi-hop questions whose answer is *linked from* what the query matches rather than similar to it | graph expansion at 0 hops against 2: whether the graph signal helps | with `overview` and `path` |
| code | docstring-to-function queries in the style of CodeSearchNet, over a few repositories | text chunks against symbol-aware chunks | with code extraction |
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

### 2. Ranking work the harness has already identified

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

Each of these is re-measured on the suites from item 1 before anyone acts on it.

### 3. Code as structure, not just text

Today source code is chunked like prose. Graphify shows how much a deterministic
pass recovers: tree-sitter yields symbols and `calls`, `imports` and `inherits`
edges with no model and nothing leaving the machine, so every GraphDog
constraint holds.

- symbol nodes -- function, class, module -- and `defines`, `calls` and `imports`
  edges, each carrying the line range it came from
- chunk boundaries at symbol boundaries, so a hit cites a whole function rather
  than an arbitrary window
- tree-sitter's WebAssembly build, loaded per language on demand, so the default
  install still compiles nothing -- the reasoning that chose `node:sqlite`

This moves the chunking fingerprint, so existing corpora are refused until they
are rebuilt, as designed. It becomes a default only after the code suite says so.

### 4. Orientation: `overview` and `path`

Graphify's report answers "what is in here, and what holds it together" before
anyone knows what to search for. `explore` needs a query first.

- **`overview`** -- communities over the document graph, hub documents, bridges
  between communities, and questions the graph is placed to answer; a CLI command
  and a read-only MCP tool. Community detection has to be deterministic -- fixed
  seed, ordered iteration, code-unit sorting -- and communities are named from
  titles, headings and tags, not by a model.
- **`path <ref> <ref>`** -- the chain of edges connecting two documents, each edge
  with the span that created it: the line a link is on, the occurrence of a
  shared tag. "Why are these related" is answered with evidence, not asserted.

Measured by the graph suite. Their output is also held to a contract property
rather than a metric: every hub, bridge and path must be checkable.

### 5. Edge provenance

Label every edge `extracted` -- written in the source: a link, a tag, a
directory, and later a call -- or `inferred` -- computed: `similar` edges today,
anything an enrichment stage adds tomorrow -- with a confidence for the inferred
ones. `similar` edges are already inferred, and nothing in the output says so.
An additive contract change to `graph_path`; cheap now, and it has to exist
before any model-derived edge does.

## Later

- **Keeping the index current unasked** -- `graphdog watch`, and a post-commit
  and post-checkout hook that runs `update`. No merge driver: the index is derived
  and never committed, which is the problem Graphify's driver exists to solve.
- **Agent integration** -- installers that register the MCP server and write the
  instruction files for a few agent runtimes (formerly "agent skill packaging").
  Steer agents to search before reading; never block a read, because an agent
  that cannot open a file because an index is stale is worse off than one with no
  index.
- **Opt-in LLM enrichment** -- concept nodes, inferred edges and community names
  from a configured model, as a separate build stage (this absorbs "query
  expansion and optional LLM summarization"). Recorded in the corpus identity the
  way the embedding model is, labelled `inferred`, every edge citing the spans it
  came from, and kept out of ranking unless enabled. The no-LLM-required
  guarantee stays.
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
