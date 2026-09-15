# Decisions

The handoff document left ten questions open and named several larger design
choices. This records what was decided, and what was rejected.

---

## 1. Name and license

**GraphDog**, MIT, commands `graphdog` and `gdog`.

The handoff flagged a collision: `nfroseth/note_graph_v2` uses `GraphDog` as a
class name for Obsidian note graph search — adjacent territory. That is a class
inside a personal repository, not a published package or a mark, and the npm
names `graphdog`, `@graphdog/core` and `@graphdog/mcp` were free. Worth a
trademark check before any commercial use; not a blocker for an MIT project.

## 2. Language and distribution

**TypeScript, published to npm.**

Originally scoped as Python. The switch was requested, and it holds up: `npx
graphdog` is a materially better distribution story for a tool whose primary
callers are AI agents, and an MCP server in the Node ecosystem is the common
case.

The NLP surface survives intact, because the architecture had already dropped
every Python-only dependency:

| Capability | Python plan | TypeScript | Effect |
|---|---|---|---|
| Japanese tokenization | character bigrams | same algorithm | none |
| Dense embedding | sentence-transformers | `@huggingface/transformers` (ONNX), same E5 model | none |
| Reranking | CrossEncoder | transformers.js cross-encoder | model choice differs |
| NER-based graph edges | spaCy `ja_core_news_lg` | — | **already removed** (see §7) |
| Morphological analysis | fugashi (needs a C build) | `kuromoji` (pure JS) available | **easier** |

The reranker default changed from `mmarco-mMiniLMv2-L12` to
`Xenova/bge-reranker-base` — a stronger multilingual cross-encoder. The model is
configuration, not a constant, because the best one changes faster than this
project will release.

## 3. Package structure

**A monorepo of three packages, each layered inward-only.**

`@graphdog/core` holds domain, application and infrastructure; `graphdog` and
`@graphdog/mcp` are thin delivery shells. The alternative — one package with
flat modules — is what the predecessor did, and is why its search logic could
not be tested without a ChromaDB instance and a spaCy model.

Splitting the delivery mechanisms also makes the equivalence guarantee
structural: they *cannot* drift, because neither owns any retrieval logic.

## 4. Minimum Node version

**Node 22.18+.**

22.5 brought `node:sqlite`, which is what keeps the default install free of
native build steps — the single biggest factor in whether `npx graphdog` works
on a stranger's machine. 22.18 enabled TypeScript type-stripping by default,
which is what lets colocated `.spec.ts` files run with no build step.

`better-sqlite3` is accepted as a fallback behind the same interface.

## 5. Dense index backend

**Rejected ChromaDB. Float32 blobs in the corpus file, scanned exhaustively.**

Chroma is a server-shaped dependency for a tool whose selling point is that it
is a file. An exhaustive scan over tens of thousands of chunks is milliseconds,
exactly reproducible, and adds nothing to the portable artifact. `VectorIndex`
is the seam where an ANN backend attaches if corpus sizes grow past that.

## 6. BM25 implementation

**Written directly, over posting lists stored in the corpus.**

Not `rank_bm25`/equivalent, for a substantive reason: the predecessor ran BM25
only over the candidates dense retrieval had already returned, and re-tokenized
the corpus on every query. An exact keyword match the embedder missed was
unreachable no matter how well it matched.

Here BM25 scores the whole corpus from persisted postings, so the two signals
are genuinely independent — which is what gives fusion something to fuse.

## 7. Graph construction rules

**Explicit structure plus one similarity rule. No NER.**

The predecessor built edges from spaCy entity extraction. That was dropped:

- `ja_core_news_lg` is a heavy, Japanese-only dependency
- entity edges are hard to explain to a user who asks why a result appeared
- above 500 nodes it **sampled random node pairs**, so two builds of the same
  corpus produced different graphs and different answers

Edges now come from authored links, shared tags, shared directories, and exact
top-k dense neighbours. Every kind is explainable in one phrase, and that phrase
is shown with the hit.

## 8. Artifact format

**`.gdog`: a gzip-compressed ustar archive of three flat files** — a manifest,
the corpus config, and a `VACUUM INTO` snapshot of the database.

Ordinary formats, so an archive can be inspected with `tar -tzf` before anyone
imports it. A hand-written reader for the small subset used — regular files
only — because every entry type a reader understands is one a crafted archive
can abuse. The manifest records each file's SHA-256 and the identities the
compatibility gate checks; an import verifies all of it, then checks the
database itself against the manifest, before writing anything. The full order
is in the [contract](contract.md#the-archive-format).

## 9. Config format

**`graphdog.json`.**

TOML was the original plan. JSON won because Node parses and emits it with no
dependency and every agent and editor already reads it. Parsing is strict about
wrong values — reporting the exact path — and permissive about unknown keys, so
a newer config still loads.

## 10. MCP SDK and transport

**The official `@modelcontextprotocol/sdk`, stdio, low-level `Server` API.**

Low-level rather than `McpServer` because it takes plain JSON Schema: the tool
contract is the same document that appears in the docs, with no schema-library
translation layer to disagree with it. That also avoids taking a zod dependency.

Read-only by default; `build_corpus` requires `--allow-write`. An agent given a
corpus to consult should not be able to rewrite it because a document told it
to.

---

## Larger choices

### Embedding default: honest weakness over heavy strength

The built-in embedder is **lexical** — signed feature hashing over BM25's
tokens. It is not semantic and does not claim to be.

The alternative was to require sentence-transformers. That makes the first run
a model download, adds a native ONNX dependency tree (with, at time of writing,
known advisories in its transitive deps), and means `npx graphdog` does not
work offline.

Shipping a weak default that *announces its own weakness* is the better trade:
`status` reports the embedding identity, and every search over such a corpus
carries a warning pointing at the semantic option. A user who needs paraphrase
recall installs one package and rebuilds.

This is the decision most exposed by the evaluation harness, and deliberately
so. On GraphDog's own docs the lexical default reaches recall@10 of 1.00 but MRR
of only 0.58 — the right document is usually found, and usually not first. That
is a measurement, not a defence. The case for changing the default should be
made by running the same dataset against a semantic model on a corpus large
enough for the difference to show.

The lexical embedder is not redundant with BM25, either: its vectors drive the
similarity edges in the graph, and the two weight terms differently — BM25 by
corpus-wide rarity, the embedder by within-chunk prominence.

### Fusion: ranks, not weighted sums

Cosine similarity and BM25 live on incomparable scales. Weighted-sum fusion
requires retuning whenever the embedding model changes. Reciprocal Rank Fusion
uses only ranks, so the two embedders above are interchangeable with no
retuning. `weighted` remains available.

### Measurement before tuning

Every ranking choice on this page is a judgment, and judgments about retrieval
are where reasonable people are confidently wrong. So `eval` exists, it ships
with a dataset, and CI gates on a checked-in baseline.

The first thing it found was a real defect: graph expansion was handing every
chunk of a reached document the same score, so one graph claim became a block of
tied candidates that RRF ordered by chunk id. Recall@10 was 0.76, two queries
missed entirely, and a query naming a field verbatim ranked 4th. One candidate
per document took recall to 1.00 and nDCG@10 from 0.54 to 0.63.

The rule that follows: a ranking change lands with a before-and-after from the
harness, not with an argument.

The gate itself then had to move. Measured on GraphDog's own docs, it moved
whenever the docs did -- a doc edit once lowered MRR by 0.096 with no code
change -- and the queries were written by the docs' own author. It now runs on
`allganize-ja`: public PDFs and questions written by someone else, committed so
that neither link rot nor a publisher's revision can change the corpus, and
chosen by a stated rule that includes whether the publisher's terms allow the
file to be redistributed at all.

### Chunking: locations are the product

The predecessor sliced text with `content[:1500]` and recorded no positions, so
a hit could not be checked against the file it came from. Every chunk now
carries its exact character span and 1-based inclusive line range, and the
document's complete text is stored untruncated.

It also **dropped** sections shorter than a minimum length. Short sections are
now merged with their neighbours instead — losing content outright is worse than
a slightly larger chunk.

### Compatibility: refuse, never degrade

Three identities are recorded and checked: store schema, embedding, chunking
fingerprint. A mismatch is exit code 4 with a remedy.

This is the one place graceful degradation is actively harmful. Searching a
corpus whose vectors came from a different model returns confident,
well-formatted, meaningless results, and nothing downstream can detect it.

### Errors are never success

Every failure mode an agent might branch on has its own exit code and its own
stable error code. Two are worth calling out:

- **5, partial build** — some files failed. The build continues, records each
  failure with its reason, and reports `partial`.
- **7, no evidence** — the query ran and nothing cleared the threshold. This is
  a real answer, not an error, but it gets its own code so a script can branch
  without parsing the payload.

### Determinism is load-bearing

A portable corpus is only portable if two machines build the same one. The
fixes this forced were real:

- `localeCompare` is locale- and ICU-dependent; every ordering uses code-unit
  comparison instead. Tie-breaking would otherwise vary by `LANG`.
- Similarity edges use exact top-k, never sampling.
- Chunk ids hash content *and* position, so an edited chunk cannot reuse a
  stale vector.

### Workspace: project first, not home

The predecessor kept all state in `~/.kiro/` keyed off an agent-specific
`skill-registry.json`. That made a corpus impossible to commit beside its
sources and tied the tool to one agent runtime.

`.graphdog/` lives in the project. The config is committed and reviewable; the
built index is gitignored, because it is derived data that would conflict on
every rebuild.

### Secrets: a recorded floor, not a guarantee

Files matching secret patterns are skipped **and recorded with the reason**, so
the gap is auditable rather than invisible. Indexing them is opt-in per source.

This is a heuristic and the documentation says so. It is not a substitute for
keeping secrets out of the tree.

---

## Rejected

| Option | Why not |
|---|---|
| ChromaDB | Server-shaped dependency; breaks "a corpus is a file" |
| spaCy NER edges | Heavy, Japanese-only, unexplainable, non-deterministic |
| GraphML as the canonical graph | A second store that cannot be updated atomically with the first |
| Required semantic embeddings | Breaks offline install; the honest weak default is better |
| Weighted-sum fusion as default | Needs retuning whenever the embedding model changes |
| TOML config | Needs a dependency for something JSON does natively |
| `McpServer` high-level API | Pulls in a schema library; JSON Schema is the contract |
| Home-directory-only workspace | A corpus cannot travel with its documents |
| Truncating stored text | Destroys the evidence the tool exists to provide |
| Refusing to search corpora with different embeddings | Unhelpful; the rank-based merge makes it defensible, and a warning makes it honest |
| Scoring a missed document as an evidence-accuracy failure | Conflates a recall failure with a citation failure; they need separate fixes |
| An `eval` MCP tool | Measuring retrieval is a maintainer's job, not something an agent should trigger mid-task |
| zip as the archive container | Its central directory can disagree with its local headers, the root of a family of extraction bugs; tar has one header per entry |
| A tar or zip dependency | Three regular files need a short reader; a general-purpose extractor supports exactly the entry types a crafted archive abuses |
| Copying the SQLite file to export | A copy taken mid-build can capture half a transaction, and a WAL file is incomplete without its sidecar |
| Archive tools over MCP | Export and import write files at caller-chosen paths; an agent consulting a corpus should not be able to |

---

## Decision record

| Field | Value |
|---|---|
| Date | 2026-09-14 |
| Approach | Agent-native portable index |
| Language | TypeScript, npm, Node 22.18+ |
| Storage | Single SQLite file |
| Default embedding | Built-in lexical hashing (semantic opt-in) |
| Fusion | Reciprocal Rank Fusion |
| Interfaces | CLI (canonical) · MCP · TypeScript API |
| Cross-corpus merge | Rank-based (RRF), never score-based |
| Quality gate | `npm run eval`; CI gates on the `allganize-ja` suite (10 government PDFs, 54 external questions, judged by page) |
| Artifact format | `.gdog` — gzip + ustar, per-file SHA-256 manifest, verified before install |
| Distribution | Homebrew tap first (macOS, Linux, WSL), npm for Windows and CI; planned in [distribution.md](distribution.md) |
| Code structure | Left to code-graph tools such as code-review-graph; an optional adapter at most |
| Trade-off accepted | Weaker default retrieval, in exchange for a zero-dependency offline install that states its own limits |
| Re-evaluate if | The lexical default proves inadequate in practice, or corpus sizes outgrow exhaustive vector scan |
