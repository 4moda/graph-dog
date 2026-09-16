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
  `export`, `import`, `install`, `uninstall`, `doctor`, `mcp`
- Agent integration: MCP registration, instructions and refresh hooks for Claude
  Code, GitHub Copilot and Kiro, written from a ledger and removable from it
- MCP: `search`, `explore`, `read`, `status`, `list_corpora`, `build_corpus` (write-gated)
- Compatibility gate, freshness reporting, auditable exclusions and failures
- Fusion that lets each signal do only what it knows: the graph adds candidates
  the direct signals missed and never reorders them; a non-semantic embedder is
  not ranked against the query at all
- Incremental updates that cost what changed: stored similarity neighbour lists,
  refreshed only where a change can have reached them
- 1480+ tests, every source file with a colocated spec, including that an
  incremental update leaves exactly what a full rebuild would

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
| **Install** | `uv tool install graphifyy`, then `graphify install` or `graphify <platform> install`, for the user or `--project` | `npm install -g graphdog`, then `graphdog install --platform <name> [--project]` | **Homebrew**, so the first step is `brew install` |
| **Upgrade** | `uv tool upgrade graphifyy`, then `graphify install` again | `npm update -g graphdog` | `brew upgrade graphdog`; `graphdog doctor` flags integrations an older version wrote |
| **Uninstall** | `graphify uninstall`, per-platform variants, `graphify hook uninstall`; `--purge` also deletes the generated output, which is otherwise kept | `graphdog uninstall`, removing exactly what a ledger records, with `--dry-run` | **`--purge`** for the data, which is otherwise kept |
| **What is installed** | `graphify hook status`; no single command for the rest | the ledger, `~/.graphdog/installed.json` | **Improve on it**: `graphdog doctor` |
| **Agent integration** | per-platform instruction files and hooks that steer the agent to the graph; a strict mode that blocks the first read | MCP registration plus instructions, written and removed for Claude Code, GitHub Copilot and Kiro | hooks that refresh the index -- item 4; steer, never block |
| **Code** | tree-sitter AST, 37 languages; `calls`, `imports`, `inherits` edges; no LLM | indexed as text chunks | **Leave to code-graph tools**; an optional adapter at most |
| **Docs, PDFs, images** | an LLM extracts concepts and relations; audio and video transcribed locally | Markdown, text and code; PDF and DOCX behind optional deps | local OCR and transcription, optional; LLM enrichment opt-in only |
| **Orientation** | a report of hub nodes, cross-module links and suggested questions; Leiden communities named by an LLM | `explore` (the graph neighbourhood around a query's hits), `suggested_queries` (from tags and headings), `status` (counts, freshness). No query-free overview, and no model anywhere in it | **Later, and small**: hub documents and top tags in `status` |
| **Edge provenance** | every edge `EXTRACTED`, `INFERRED` or `AMBIGUOUS` | every edge explained in a phrase but unlabelled -- although `similar` edges are computed, which is to say inferred | **Adopt** |
| **Citations** | file and line for code nodes | an exact line range on every hit, verbatim through `read` | GraphDog's reason to exist; the rule for everything new |
| **Keeping current** | cache, `--update`, `watch`, git hooks, a merge driver for the committed `graph.json` | incremental `update` that costs what changed and lands exactly where a rebuild would, freshness reporting, compatibility gate | **Item 4**: each agent's own mechanism -- hooks where they exist, instructions where they do not -- running `update`. Git hooks opt-in; no watcher; no merge driver, since the index is never committed |
| **Views and exports** | interactive HTML, Obsidian, GraphML, Neo4j, SVG, a wiki | none | **Later**: read-only exports of the store |
| **Evaluation** | public benchmarks (LOCOMO n=300, LongMemEval-S n=50): recall and end-to-end QA accuracy, QA scored by an LLM judge validated against a second judge (90.6% agreement, kappa 0.81) | 15 hand-judged queries over its own docs; retrieval and citation metrics; a CI gate | **Both kinds are needed** -- item 1 |
| **Privacy** | code stays local; other inputs go to the configured LLM backend unless that backend is local | nothing leaves the machine; the optional ONNX models embed and rerank text locally, and none of them generates any | keep |

## Next

Items 1 and 2 are independent and can proceed in parallel. Everything after them
is a ranking or graph change, and lands with a before-and-after from item 1.

### 1. Evaluation: a dataset that can tell a change from noise

**The gate has moved to a frozen, external suite.** CI now gates on
`allganize-ja` (see [its README](../../eval/suites/allganize-ja/README.md)):
fifteen Japanese government PDFs, committed and pinned by SHA-256, with 56
questions written by Allganize rather than by GraphDog's authors, each judged by
the page that answers it. Questions the dataset marks as answered by an image
are left out: GraphDog extracts text and does not read images, so they would
measure a capability it does not claim. Documents were chosen by a stated rule,
never by results. GraphDog's own docs remain a suite that reports but does not
gate.

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
  - No query whose answer is absent. Not measuring it hid a defect for the
    whole life of the project: **abstention could not work**. Every score in a
    response is relative -- fusion normalizes its best hit to 1.0 -- so
    `minScore` could never reject a result set, and exit 7 fired only when a
    query shared no vocabulary with the corpus at all. A two-document corpus
    about JWTs answered "published research on protein folding" at 1.0 because
    one common word was shared, and the CI test asserting exit 7 passed for the
    wrong reason: its query produced no candidates and never reached the
    threshold. Fixed with `search.minTermCoverage`, an absolute measure; still
    to build is the suite that scores abstention as a metric rather than by
    hand on eight questions. **Now built**: a query carries
    `"expect": "no_answer"`, the gate suite has ten of them, and `abstention`
    and `false_abstention` are reported and gated like any other metric. It
    refuses 6 of the 10 at 0 false refusals out of 56 answerable questions.
    The four it answers are the near ones, and Japanese politeness boilerplate
    is part of why: "...について説明してください" shares bigrams with anything,
    so a question's register lifts its coverage before its subject does.
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

Designed in [Distribution and lifecycle](distribution.md).

**Built: connecting an agent, and taking it back off.**

- **`graphdog install --platform <claude|copilot|kiro> [--project]`** registers
  the MCP server -- the installed binary, never `npx` -- and adds GraphDog's
  instructions: its own file where the platform reads several (Copilot, Kiro), a
  marker-delimited block where it reads one (Claude Code's `CLAUDE.md`). A scope
  a platform does not have is refused naming the one to use, rather than written
  to a plausible-looking path where it would silently do nothing.
- **`graphdog uninstall`** removes exactly what the ledger
  (`~/.graphdog/installed.json`) says was written, and, for the platform asked
  about, whatever is at the known locations even when no record mentions it --
  which is a teammate's clone of a repository somebody else ran `--project` in.
  A file GraphDog created goes; a file it only added to comes back byte for byte.
- **`--dry-run` on both**, naming every file and key, because "what are you
  about to write in my repository" deserves an answer before the fact.

- **One install gives the CLI and the MCP server.** `graphdog` depends on
  `@graphdog/mcp` and serves the protocol as `graphdog mcp`, which is what the
  registration names -- `npm install -g graphdog` does not put `graphdog-mcp` on
  anyone's `PATH`, so registering that would have failed at the agent's first
  search.
- **`--purge --yes`** deletes GraphDog's own data: home corpora whole, and the
  project's built indexes, never a project's corpus config. On its own `--purge`
  lists what it would delete with sizes and refuses. Homebrew cannot do this
  part: `brew uninstall` removes only what it installed, and `--zap` is for casks.
- **`graphdog doctor`** reports everything installed and anything broken, exits
  non-zero on broken and not on a warning, and never loads an embedding model to
  find out.
- **Hooks** -- item 4.
- **The Homebrew formula**, in [`packaging/homebrew/`](../../packaging/homebrew/),
  with a script that fetches the published tarball's checksum rather than having
  anyone type it.

**Still to build:**

- **The tap repository**, `4moda/homebrew-graphdog`, so `brew install
  4moda/graphdog/graphdog` works; homebrew-core once GraphDog meets its
  acceptance policy. npm remains for Windows without WSL and for CI.
- **Extras and model caches move out of the install directory**, so a
  `brew upgrade` does not silently drop semantic search.

### 3. Ranking: what is fixed, and what the suites still show

**Fusion weighting is done.** The harness had shown the default ranking below
plain BM25 on all three suites. Two rules fixed it, each measured before and
after:

- **The graph scores only candidates dense and BM25 did not find.** It appends
  documents the direct signals missed instead of reordering the ones they found.
- **A non-semantic embedder is not ranked against the query.** The built-in
  lexical embedder hashes BM25's own tokens, so fusing it in was one signal
  voting twice. Its vectors are still built, for the graph's `similar` edges.

| corpus (nDCG) | BM25 | + dense | + graph | old default | **now** |
|---|---|---|---|---|---|
| SciFact, 5,183 documents (k=10) | 0.645 | 0.560 | 0.644 | 0.559 | **0.645** |
| allganize-ja, 15 PDFs (k=3) | 1.000 | 0.993 | 0.744 | 0.803 | **1.000** |
| GraphDog's own docs, 5 linked files (k=10) | 0.764 | 0.764 | 0.572 | 0.633 | **0.753** |

On the gating suite that took MRR from 0.741 to 1.000 and recall@3 from 0.982 to
1.000: every one of the 56 questions now puts its judged page's document first.
The two side effects are recorded rather than hidden:

- **Page-level evidence reads 0.768, against 0.782 before.** The count of
  correctly cited pages did not fall -- 43 both times. The 56th query now
  returns a checkable span where it used to return none, and that span cites the
  wrong page. It is the citation problem below, not a ranking regression.
- **On GraphDog's own docs, recall@10 fell from 1.000 to 0.944.** One document
  that only the graph reached now sits below ten direct hits. That is the price
  of strict appending, and the suite that should price it -- multi-hop questions
  whose answer is *linked from* what the query matches -- does not exist yet.

Earlier, the harness's first finding was a defect: graph expansion gave every
chunk of a reached document the same score, so one graph claim became forty tied
candidates that RRF ordered by chunk id. Fixing it -- one representative chunk
per document -- moved every metric on the built-in dataset at once:

| | before | after |
|---|---|---|
| recall@10 | 0.762 | **1.000** |
| precision@10 | 0.114 | **0.150** |
| MRR | 0.536 | **0.577** |
| nDCG@10 | 0.536 | **0.632** |
| queries that missed entirely | 2 | **0** |

**Citation is the weakness, and it is not a PDF weakness.** The gate's 13 failing
questions all retrieve the right document at rank 1 and cite the wrong page --
retrieval is not the problem, locating the answer inside a long document is. The
failures split in half:

| | | |
|---|---|---|
| **6** | off by one page | the heading is on one page and the answer on the next |
| **7** | 4 to 80 pages away | a different section of a 90-page document matched better |

The second group is format-independent by construction, and the numbers say so.
The docs suite -- Markdown, judged by line range -- sits at **0.591** against the
PDF suite's 0.768. The two units differ, a page being coarser than a line range,
so they are not directly comparable; what is comparable is that nothing here
points at PDFs as the weak format. Converting PDFs to Markdown would move the
corpus into the format that currently measures worse, and would cost the page
citation that lets a reader open the original.

That 0.591 is itself new: the docs suite's judgments had decayed. They point
into this repository's own design documents, which these last few weeks
rewrote, so the suite was reporting moved paragraphs as wrong citations --
`scripts/relocate-judgments.mjs` moves a judgment to wherever its passage went,
and refuses to guess when a passage was rewritten rather than moved.

**What the suites still show, and what is left to do here:**

- **Citations land in the wrong place, in both formats.** Chunks already never
  span a page, so the remaining off-by-one cases are the opposite problem: the
  page split separates a heading from what it introduces. The 7 far-away cases
  need the chunk that *answers* the question to outrank the chunk that merely
  shares its words -- which is what a semantic embedder or a reranker is for,
  and neither has ever been measured here.
- **Paraphrase misses its section.** On the docs suite the two paraphrase
  queries find every judged document and cite the wrong section in each.
**Measured since: neither the semantic model nor the reranker fixes citation.**
`run-eval.mjs --semantic` and `--rerank` build and query a suite with each, and
on the gating suite retrieval had no headroom to begin with -- recall, MRR and
nDCG are all 1.000 on the lexical default -- so the only thing either could move
was where the answer is cited from.

| on `allganize-ja` (56 questions, k=3) | citation |
|---|---|
| lexical default | 0.768 |
| `multilingual-e5-small` | 0.768 |
| `bge-reranker-base` | 0.768 |

Identical totals, and underneath them two different stories. The semantic model
**fixed 4 of the 7 far-away failures** -- the +17, -20, -41 page misses, which is
what it should be good at -- and broke 5 other questions, for no net change. It
left 5 of the 6 off-by-one failures exactly where they were. The cross-encoder
moved **nothing at all**: the same 13 questions fail identically, because the
document already ranks first and reranking the shortlist does not change which
chunk of it is cited.

**The docs suite needs its judgments relocated whenever the docs change**, which
is every few commits, and `scripts/relocate-judgments.mjs` is a manual step
somebody has to remember. The durable fix is to judge by anchor text rather than
by line number -- "the passage beginning *Cosine similarity and BM25 live on*"
survives any edit that does not rewrite that sentence, where `166-172` does not
survive a paragraph being inserted above it.

**The two groups are one problem.** Reading the failing pages says so, and the
page delta had been standing in for a diagnosis. In all six off-by-one cases the
correct page is the **second** BM25 hit within the same document, one rank behind
the page that beat it -- their fused scores are 1.000 and 0.984, which is exactly
what one RRF rank apart looks like and not a difference in relevance at all. And
the winner is always the page that *announces* the topic while the loser is the
page that answers it: p4 carries "5.1.3 Confirming conformity with the
functional standard", p5 carries the criteria; p12 carries "the conformity date
shall be set as follows", p13 carries the table. BM25 is not wrong that the
first page matches the question's words better. The answer is on the second.

That is the same failure as the far-away group with a smaller number attached,
so there is no small tractable subset here: **the chunk whose words best match a
question is not the chunk that answers it**, and every one of the 13 is that.
It also explains why the semantic model fixed none of these while fixing four
far-away ones -- both candidates are about the same topic, so semantic
similarity does not separate them either.

Two hypotheses died on the way, and are recorded so nobody spends the afternoon
again:

- **"Chunks straddle pages."** They never have: `splitOnPages` predates this.
- **"BM25 cannot see a chunk's heading, only the chunk that contains it."** True,
  and irrelevant here -- all 565 chunks of the PDF corpus have an empty
  `headingPath`, because headings come from Markdown syntax and extracted PDF
  text has none. Indexing the heading with each chunk was tried anyway, for the
  consistency argument that the embedder already gets it: no effect on the gate,
  and on the docs suite it trades the thing being fixed for another one --
  MRR +0.067 and nDCG +0.039 against citation -0.045. Reverted.

On the docs suite, where retrieval *did* have headroom, the semantic model helps
across the board: recall 0.911 to 0.933, MRR 0.744 to 0.817, nDCG 0.750 to 0.815,
citation 0.591 to 0.619, and the one query that missed entirely now lands. That
is the case for a semantic default on prose corpora; it is not a case for it
fixing citations.
- **Nothing measures what the graph is for.** Its recall contribution shows up
  on one query of one suite. The graph suite in item 1 is what would price it.

### 4. Keeping the index current, unasked

**An update now costs what changed.** It always gave the right answer -- a test
proves an incremental update leaves exactly what a full rebuild would, down to
chunk ids, BM25 statistics and every edge -- but it cost nearly as much as one,
because every update recomputed the similarity neighbours of every chunk against
every other chunk. On the 5,183-document SciFact corpus that was 140 of the 145
seconds, whether or not a single file had changed.

Two changes, described in [the architecture](architecture.md#an-update-costs-what-changed):
the neighbour lists are stored and only the ones a change can have reached are
recomputed, and the nearest few are now selected into a bounded list instead of
scoring every chunk into a full one and sorting it to keep five.

| on 5,183 documents / 12,110 chunks | before | after |
|---|---|---|
| update, nothing changed | 145 s | **2.1 s** |
| update, one document changed | 147 s | **3.3 s** |
| update, one document deleted | -- | **2.2 s** |
| full rebuild | 167 s | **106 s** |

The equivalence test is what makes this safe to have done, and it was extended
with a fixture whose vectors really differ, since the old one embedded
everything to the zero vector and so drew no similarity edges at all. The same
claim was checked on the real corpus: one document edited, one deleted and one
added, updated in 2.5 s, gives a database identical to the 110 s rebuild across
all 1,277,182 rows of documents, chunks, vectors, postings, term frequencies,
nodes, edges and neighbour lists.

**Built:** the index keeps itself current, triggered through each agent's own
mechanism. Part of `install`, not a command of its own.

- **Claude Code: hooks.** `SessionStart` when a session opens, `Stop` when a
  turn ends, written into `.claude/settings.json` beside whatever else hooks
  those events. Deterministic, and costs no tokens.
- **Copilot: instructions**, because it has no hook mechanism. Every search
  already reports the corpus's freshness, so the rule is about an observable
  fact: if a search says stale, refresh and search again.
- **Git hooks: opt-in**, `--git-hooks`, for using GraphDog outside an agent,
  marker-delimited so an existing hook script keeps its own lines.
- The command is `graphdog update --all --quiet || true` -- `--all` added with
  it, because refreshing the first of three corpora is the silent staleness the
  trigger exists to prevent.

**Still to do here:**

- **Kiro's agent hooks.** Which of its events correspond to `SessionStart` and
  `Stop` is unconfirmed, and a guess would be a hook that silently never fires.
- **A tool the instruction can name.** Split `build_corpus` -- `update_corpus`,
  incremental only, exposed by default; `full` stays behind `--allow-write`.
- **Writing a hook manager's configuration.** husky, lefthook and pre-commit are
  detected and the install refuses, naming the line to add; writing it for them
  is still manual.


**Not a file watcher.** A watcher is a daemon to start, supervise and stop, and
it fires on saves that mean nothing -- an editor's swap file, a half-written
line, a build directory. Every trigger above is a moment the tree is worth
indexing. None of them passes anything about what changed: the update finds out,
and now that finding out is cheap, that is the whole design.

### 5. Edge provenance

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
