# Architecture

## Three packages

```
graphdog            CLI          →┐
@graphdog/mcp       MCP server   →┤→  @graphdog/core
```

The CLI and the MCP server are both *delivery mechanisms*. Neither contains
retrieval logic, and neither constructs an adapter: both open a corpus through
the same composition root and call the same use cases.

That is the mechanism behind the CLI/MCP equivalence guarantee. It is not a
convention anyone has to remember — there is simply no second implementation
that could drift. A test asserts byte equality between `graphdog search --json`
run as a subprocess and the MCP `search` tool's structured content.

## Layers, inward only

Each package is an onion. Dependencies point inward; nothing in an inner layer
imports from an outer one.

```
┌─ infrastructure ─────────────────────────────────┐
│  SQLite · filesystem · git · ONNX models · JSON  │
│  ┌─ application ────────────────────────────────┐│
│  │  use cases · ports · DTOs                    ││
│  │  ┌─ domain ─────────────────────────────┐    ││
│  │  │  model · services · errors           │    ││
│  │  │  pure: no IO, no clock, no random    │    ││
│  │  └──────────────────────────────────────┘    ││
│  └──────────────────────────────────────────────┘│
└──────────────────────────────────────────────────┘
                        ▲
              composition/  wires it together
```

### domain — pure logic

`packages/core/src/domain/`

Entities and value objects (`Chunk`, `Location`, `Scores`, `Freshness`,
`CorpusIdentity`) plus the algorithms that operate on them: tokenization,
chunking, BM25 scoring, fusion, graph construction, graph expansion, link
resolution, snippet selection.

No IO, no clock, no randomness. Anything ambient is injected — the chunker takes
a hash function rather than importing `node:crypto`, and graph expansion takes a
neighbour-lookup callback rather than knowing the graph is in SQLite.

The payoff: the entire retrieval algorithm is testable with hand-written inputs
and exact expected outputs, and it is *reproducible*. Two builds of the same
corpus produce identical chunks, identical ids and identical rankings.

### application — use cases and ports

`packages/core/src/application/`

- `usecase/` — `buildCorpus`, `searchCorpus`, `exploreCorpus`, `readDocument`,
  `describeCorpus`. Each orchestrates domain services through ports.
- `ports/` — the interfaces the outside world must satisfy: repositories,
  source readers, extractors, embedding models, rerankers, clock, hasher,
  logger.
- `dto/` — the wire contract and the mappers that produce it. One definition,
  used by every interface.

Use cases never import an adapter. `searchCorpus` takes a `CorpusStore`, so the
query pipeline is unit-tested against an in-memory fake with exact scores — no
SQLite file, no embedding model, no filesystem.

### infrastructure — adapters

`packages/core/src/infrastructure/`

| Port | Adapter |
|---|---|
| `CorpusStore` | `SqliteCorpusStore` over `node:sqlite` |
| `SourceReader` | `LocalSourceReader`, `GitSourceReader` |
| `ContentExtractor` | text/Markdown, PDF, DOCX |
| `EmbeddingModel` | `HashingEmbeddingModel`, `TransformersEmbeddingModel` |
| `Reranker` | `TransformersReranker` |
| `Clock` / `Hasher` / `Logger` | `system-adapters.ts` |

### composition — the wiring

`packages/core/src/composition/corpus-context.ts` is the only module that sees
both an interface and its implementation. `openCorpus()` resolves the workspace,
loads the config, opens the store, builds the embedding model and source
readers, and hands back a context.

The CLI and the MCP server each call it and nothing else.

## Storage: one file

A corpus is a single SQLite file. Documents and their complete text, chunks,
dense vectors, BM25 postings, the relation graph, build failures and exclusions
all live in it.

The predecessor spread this across ChromaDB, a GraphML file, a separate SQLite
full-text database and a JSON state file. None could be updated together, so an
interrupted build left the four disagreeing — with no way to detect it. One file
with one transaction removes that class of bug, and makes "portable corpus"
mean "copy this file".

Notable choices:

- **Vectors are float32 blobs scanned exhaustively.** For the corpus sizes
  GraphDog targets this is milliseconds, exactly reproducible, and adds nothing
  to the portable artifact. `VectorIndex` is the seam where an ANN backend
  attaches if that stops holding.
- **Postings are a table**, so BM25 scores the whole corpus on every query
  rather than re-ranking whatever dense retrieval happened to return.
- **The graph is derived and rebuilt wholesale** at the end of every build. That
  costs a pass and removes orphan edges pointing at deleted documents.

## The query pipeline

```
query
  ├─ dense     top-k by cosine, filtered by the model's declared noise floor
  ├─ BM25      whole corpus, Okapi BM25 over stored postings
  └─ graph     BFS from the strongest direct hits, decaying per edge kind
        ↓
     fuse      RRF (default) or weighted sum
        ↓
     rerank    optional cross-encoder over the shortlist
        ↓
     assemble  snippet + location + per-signal scores + graph path
```

### Why the dense floor is on the model

Dense search returns the top-k by similarity *however low that is*. On a small
corpus every chunk comes back, and rank-based fusion then awards credit to all
of them — so an unrelated document lands at a plausible-looking score. No
post-fusion threshold fixes this, because the inflation depends on corpus size.

So the filter is at candidate generation, and the *model* declares the floor:
the lexical hasher produces meaningful similarity from bucket collisions and
needs a high floor; an E5 model scores almost everything above 0.7 and needs a
different one. Only the model knows what its scale means.

### Why RRF by default

Cosine similarity and BM25 are incomparable scales. Fusing ranks rather than
values means the built-in lexical embedder and a sentence-transformers model are
interchangeable with no weight retuning. `weighted` remains available for anyone
who wants to tune for their own corpus.

The same argument, one level up, is why a cross-corpus search merges by rank
too: each corpus normalizes its own best hit to `1.0`, so a weak corpus's best
and a strong corpus's best are both `1.0`. Interleaving those numbers would
promote whichever corpus had least to offer. Ranks do not carry that distortion,
so merging is a second RRF pass, and only `final` is rewritten — per-signal
scores keep the calibration of the corpus that produced them.

### Why the graph contributes one chunk per document

A graph edge is a claim about a *document*: "this file is connected to what you
found". Handing that score to every chunk of the file turns one claim into forty
tied candidates, which RRF then orders by chunk id — arbitrarily. On a small
corpus that is enough to push a chunk with no textual evidence above one that
matched the query exactly.

So a reached document contributes exactly one candidate: its best chunk under
the direct signals where it has one, its first chunk otherwise. The graph
therefore amplifies real evidence where there is any, and can still introduce a
document the query never matched, without flooding the candidate pool.

This was not reasoned out in advance. The evaluation harness found it: a query
naming a field verbatim was landing at rank 4. Fixing the spread took recall@10
on the built-in dataset from 0.76 to 1.00 and nDCG@10 from 0.54 to 0.63.

## The graph

Every edge kind must be explainable in one phrase, because a hit reached through
the graph shows that phrase to the user:

| Edge | Source | Decay |
|---|---|---|
| `links_to` | a Markdown or wiki link, resolved | 0.65 |
| `linked_from` | the reverse | 0.55 |
| `similar` | top-k dense neighbours above a threshold | 0.50 |
| `same_tag` | shared front-matter or inline tag | 0.45 |
| `same_directory` | co-location | 0.30 |

Authored links are trusted most; co-location least. Tag and directory edges
route through a waypoint node, keeping edge count linear in group size rather
than quadratic, and a group larger than `maxGroupSize` produces no edges at all
because a tag on forty documents says nothing.

The predecessor sampled random node pairs once a graph passed 500 nodes, so two
builds of the same corpus produced different graphs. Nothing here is sampled.

## Compatibility, not degradation

Three identities are recorded with every corpus:

- `schemaVersion` — the physical layout
- `embeddingId` — which model produced the vectors
- `chunkingFingerprint` — how text was cut, which is what line ranges *mean*

Any mismatch is refused with exit code 4 and a remedy. This is the one place
where graceful degradation would be actively harmful: searching a corpus whose
vectors came from a different model returns confident, well-formatted,
meaningless results, and nothing downstream can detect it.

## Portable archives

`export` and `import` move a corpus between machines as one `.gdog` file, and
the layers split the work as they do everywhere else:

- **domain** — the manifest and every check on it: entry names against a fixed
  list, sizes and SHA-256s, the format version. Pure, so it is tested against
  hand-built hostile archives with no filesystem.
- **application** — the order the checks run in, and what both sides agree on:
  a database with triggers or views is refused by export as well as import, so
  an export never ships something an import would reject.
- **infrastructure** — gzip, a ustar reader that accepts regular files only, a
  read-only SQLite inspector with `trusted_schema` off, and an installer that
  stages the corpus and moves it into place with one rename.

Export deliberately opens the store without the embedding model: for a
semantic corpus, loading the model just to copy a file would mean a download.

## Determinism

The reproducibility claim is load-bearing — it is what makes a corpus portable
and evaluation meaningful. Concretely:

- String ordering uses code-unit comparison, never `localeCompare`, which varies
  by locale and ICU version.
- Similarity edges come from exact top-k neighbours, never sampling.
- Ties in every ranking break on id.
- Chunk ids hash content *and* position, so an edited chunk cannot reuse a
  stale vector.
- The built-in embedder is pure arithmetic over hashed tokens.

## Testing

Every source file has a colocated `*.spec.ts`, run by `node --test` with Node's
native TypeScript support — no test framework, no transpile step.

The layering is what makes this tractable:

- **domain** — pure functions, exact inputs and outputs
- **application** — use cases against in-memory fakes, with hand-written scores
- **infrastructure** — real SQLite files, real temporary directories, a real git
  repository
- **cross-cutting** — CLI and MCP asserted byte-identical, with the CLI actually
  run as a subprocess

### Measurement, separately

Unit tests say the code does what it was written to do. They cannot say whether
search is any good, because the answer is a judgment about documents.

`graphdog eval` closes that gap: a hand-judged dataset, the real `searchCorpus`
(not a reimplementation of it), and Recall@K, Precision@K, MRR, nDCG@K,
evidence accuracy by line or by page, and latency percentiles. `npm run eval`
runs every suite under `eval/suites/`, each building its corpus afresh in a
temporary workspace. CI gates on `allganize-ja`: Japanese government PDFs,
committed and checked against a lock of SHA-256s on every run, with questions
written outside the project. GraphDog's own docs are a suite too, but they
report rather than gate, because editing the docs moves their numbers.

The metrics themselves are pure domain functions over a ranked list and a set of
judgments, so they are tested against worked examples with known answers rather
than against whatever the search happens to return today.

## Constraints worth knowing

- Node's type-stripping runs `.spec.ts` files directly, which rules out
  parameter properties, enums, namespaces and decorators. `const` objects with
  `as const` are used instead of enums throughout.
- Relative imports carry `.ts` extensions; `rewriteRelativeImportExtensions`
  emits `.js` at build time. This is what lets tests run on source while the
  published package stays standard ESM.
- `node:sqlite` returns null-prototype rows, so every column is read through an
  accessor rather than by walking the object.
