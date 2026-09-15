# GraphDog

**Agent-native portable knowledge index.** Searches local documents with dense
vectors, BM25 and a relation graph, and answers with *evidence*: a file ref, an
exact line range, and a breakdown of which signal found it.

Built for AI agents to call. CLI-first, MCP-native, offline, no LLM required.

```console
$ npx graphdog init docs --source ./docs
$ npx graphdog build
$ npx graphdog search "JWT rotation"

1. アクセストークン設計 > ローテーション
   docs/design/token.md#L10-L13  score 1.000 via dense
   トークンの有効期限は 1 時間とし、リフレッシュトークンで更新する。
   dense 1.00  bm25 1.00
```

That `docs/design/token.md#L10-L13` is not decoration. Hand it back to
`graphdog read` and you get those exact lines, unmodified.

---

## Why this exists

Most retrieval tools are built for a chat UI: they return a blob of text and
leave you to trust it. An agent needs something different — a result it can
*verify*, *explain* and *carry with it*:

| | What GraphDog does |
|---|---|
| **Verifiable** | Every hit carries `ref` + line range. `read` returns that span verbatim. |
| **Explainable** | Every hit reports what dense, BM25, graph and rerank each contributed, and the edge chain that reached it. |
| **Honest** | Nothing matched? It says so, with a dedicated exit code — it does not return the least-bad rows. |
| **Portable** | A corpus is one SQLite file with its identities recorded. Copy it; a mismatched reader refuses rather than guesses. |
| **Offline** | Default install: no model download, no network, no service. |

## Install

```console
npm install -g graphdog        # the CLI
npx graphdog --help            # or just run it
```

Requires Node 22.18+. Zero runtime dependencies for the CLI; the MCP server
adds only the official Model Context Protocol SDK.

## Use it

### From a terminal

```console
graphdog init docs --source ./docs   # create a corpus in .graphdog/
graphdog add ../spec --git           # add a git repo (records commit SHAs)
graphdog build                       # index everything
graphdog update                      # re-index only what changed

graphdog search "how are keys rotated"
graphdog search "onboarding" --all   # every corpus at once, merged by rank
graphdog explore "access token"      # + the graph neighbourhood
graphdog read 'docs/token.md#L10-L24'
graphdog status                      # is this corpus current and usable?
graphdog eval eval/docs.json         # measure retrieval against a judged dataset
graphdog export                      # package the corpus as one .gdog file
graphdog import docs.gdog            # verify someone else's and install it
```

Every command takes `--json` for the machine-readable contract.

### From an agent (MCP)

```jsonc
{
  "mcpServers": {
    "graphdog": {
      "command": "npx",
      "args": ["-y", "@graphdog/mcp", "--cwd", "/path/to/project"]
    }
  }
}
```

Exposes `search`, `explore`, `read`, `status` and `list_corpora`. Read-only by
default — `build_corpus` requires `--allow-write`, so an agent cannot rewrite
the corpus it is consulting because a document told it to.

**The CLI and the MCP server return identical results.** Both call the same use
cases through the same serializers; a test asserts byte equality between them.

### From TypeScript

```ts
import { openCorpus, searchCorpus } from "@graphdog/core";

const corpus = await openCorpus({ corpus: "docs" });
try {
  const { hits } = await searchCorpus(
    { query: "JWT rotation" },
    {
      store: corpus.store,
      config: corpus.config,
      embedding: corpus.embedding,
      freshness: corpus.freshness(),
    },
  );
  for (const hit of hits) console.log(hit.ref, hit.location, hit.scores);
} finally {
  corpus.close();
}
```

## How search works

```
query
  ├─ dense retrieval  (whole corpus, filtered by the model's own noise floor)
  ├─ BM25 retrieval   (whole corpus, real posting lists)
  └─ graph expansion  (from the strongest direct hits, score decaying per hop)
        ↓
     fusion (Reciprocal Rank Fusion by default)
        ↓
     optional cross-encoder rerank
        ↓
     evidence: ref + line range + per-signal scores + graph path
```

Two details that matter:

- **BM25 scores the whole corpus**, not a shortlist of what the vector search
  already found. An exact keyword match the embedder misses is still reachable.
- **Rank fusion, not weighted sums.** Cosine similarity and BM25 live on
  incomparable scales, so fusing *ranks* means swapping the embedding model
  needs no weight retuning.
- **The graph contributes one candidate per document**, not one per chunk. A
  graph edge is a claim about a file; spreading it over forty chunks would turn
  one claim into forty tied candidates.

### Several corpora at once

`--corpus` is repeatable, `--all` searches everything visible, and each hit
reports which corpus it came from and where it placed within it. The merge is
rank-based, for the same reason fusion is: every corpus normalizes its own best
hit to `1.0`, so interleaving those numbers would promote whichever corpus had
the least to offer.

Corpora built with different embedding models can still be searched together —
the response says so in a warning rather than refusing.

### Measuring it

```console
graphdog eval eval/docs.json --fail-under recall=0.8
graphdog eval eval/docs.json --baseline eval/baseline.json --out eval/latest.json
```

A dataset is plain JSON: queries, the refs that answer them, optionally a grade
and the exact lines. `eval` runs them through the real search pipeline and
reports Recall@K, Precision@K, MRR, nDCG@K, evidence-line accuracy and latency
percentiles, then exits **8** if a threshold or a baseline was breached.

GraphDog ships a dataset over its own design docs; `npm run eval` runs it and CI
gates on it. The first thing it found was a real ranking defect — see
[the roadmap](docs/design/roadmap.md).

### Moving a corpus

```console
graphdog export --out docs.gdog      # on the machine with the sources
graphdog import docs.gdog            # anywhere else: searchable immediately
```

A `.gdog` file is a gzip'd tar of the index, its config and a manifest with a
SHA-256 for every file, so `tar -tzf docs.gdog` lists it. Import verifies all of
it before writing anything; refuses links, path traversal, triggers, and any
manifest that misdescribes its contents; and installs with a single rename. The
checksums prove the file arrived intact, not who made it — import archives from
people you would take the documents from.

## Japanese and multilingual text

Works out of the box. CJK runs are indexed as character bigrams — the standard
dependency-free way to get usable Japanese recall without a morphological
analyzer — and everything normalizes through NFKC, so `ＪＷＴ`, `JWT`, `ｱｸｾｽ`
and `アクセス` all match.

For semantic (paraphrase) matching, opt in:

```console
npm install @huggingface/transformers
graphdog init docs --source ./docs --semantic
```

That runs `multilingual-e5-small` locally via ONNX. No Python, no API key; the
first run downloads the weights, after which it is fully offline.

## Embedding: the honest default

The built-in embedder is **lexical**, not semantic: signed feature hashing over
the same tokens BM25 uses. It exists so `npx graphdog` works in seconds with no
model download and produces byte-identical vectors on every machine.

It does not pretend otherwise. `status` reports the embedding identity, and
every search over such a corpus carries a warning pointing at the semantic
option. Swapping models is a config line plus a rebuild — and a corpus built
with one model is *refused*, not silently mis-searched, by a reader configured
for another.

## Exit codes

| Code | Meaning |
|---|---|
| 0 | OK |
| 2 | Usage error |
| 3 | Corpus or ref not found |
| 4 | Incompatible corpus — rebuild required |
| 5 | Build completed, but some files failed |
| 7 | Query ran, nothing cleared the evidence threshold |
| 8 | Evaluation ran and breached a threshold or its baseline |

`5`, `7` and `8` are the ones worth wiring into a script: a partial index, an
empty result and a quality regression are all real outcomes that would otherwise
pass as success.

## What gets indexed

Markdown, plain text, and source code by default; PDF and DOCX with optional
extras. Skipped, and **recorded with a reason** so the gap is auditable:

- files matching secret patterns (`.env`, `*.pem`, `*credentials*`, …) — opt in with `indexSecrets`
- files over the size limit, empty files, unreadable files
- dependency and build directories

Secret exclusion is a heuristic floor, not a guarantee. It is not a substitute
for keeping secrets out of the tree.

## Packages

| Package | What it is |
|---|---|
| [`graphdog`](packages/cli) | The CLI. `graphdog` / `gdog`. |
| [`@graphdog/mcp`](packages/mcp) | The MCP server. `graphdog-mcp`. |
| [`@graphdog/core`](packages/core) | Domain, use cases and adapters. |

Each package is layered inward-only: `domain` ← `application` ←
`infrastructure`, wired at a single composition root. See
[docs/design/architecture.md](docs/design/architecture.md).

## Documentation

- [Architecture](docs/design/architecture.md) — the layering, and why
- [Contract](docs/design/contract.md) — the JSON every interface returns
- [Decisions](docs/design/decisions.md) — what was chosen, and what was rejected
- [Roadmap](docs/design/roadmap.md) — what is not built yet, what to take from Graphify, and the evaluation plan
- [Distribution](docs/design/distribution.md) — the planned Homebrew install, upgrade and uninstall
- [Contributing](CONTRIBUTING.md) — conventions and how to run the tests

## Status

Early. The search pipeline, incremental builds, cross-corpus search, the
evaluation harness, portable export/import, the CLI and the MCP server are
implemented and tested (1290+ tests, plus a CI-gated quality baseline).
Registry distribution and archive signing are designed but not yet built — see
the roadmap.

## License

MIT
