# graphdog

Search local documents with dense vectors, BM25 and a relation graph, and get
back *evidence*: a file ref, an exact line range, and which signal found it.

```console
npx graphdog init docs --source ./docs
npx graphdog build
npx graphdog search "JWT rotation"
```

```
1. Access Token > Rotation
   docs/design/token.md#L10-L13  score 1.000 via dense
   Tokens expire after one hour. See key management for rotation.
   dense 1.00  bm25 1.00
```

`docs/design/token.md#L10-L13` goes straight back into `graphdog read` and
returns those exact lines.

## Commands

| Command | What it does |
|---|---|
| `init [name] --source <path>` | Create a corpus in `.graphdog/` |
| `add <path> [--git]` | Register another source |
| `build` | Index everything |
| `update` | Re-index only what changed |
| `search "<query>"` | Find evidence |
| `explore "<query>"` | Search, plus the graph neighbourhood |
| `read <ref>` | Print the exact source text |
| `status` | Is this corpus current and usable? |
| `list` | Every corpus visible from here |
| `eval <dataset.json>` | Measure retrieval quality against hand-judged queries |
| `export [--out <path>]` | Package a built corpus as one verifiable `.gdog` file |
| `import <archive.gdog>` | Verify an archive and install the corpus inside it |

Every command takes `--json` for the machine-readable contract, and `--help`.

`search` and `explore` take `--corpus` more than once, or `--all`, to search
several corpora at once; results are merged by rank and each hit says which
corpus it came from.

## Exit codes

| Code | Meaning |
|---|---|
| 0 | OK |
| 2 | Usage error |
| 3 | Corpus or ref not found |
| 4 | Incompatible corpus — rebuild required |
| 5 | Build completed, some files failed |
| 7 | Query ran, nothing cleared the evidence threshold |
| 8 | Evaluation ran and breached a threshold or its baseline |

```bash
if ! graphdog search "$q" --json > result.json; then
  case $? in
    7) echo "not in the corpus" ;;
    4) graphdog build --full ;;
  esac
fi
```

## Measuring retrieval

```console
graphdog eval eval/docs.json --fail-under recall=0.8 --fail-under mrr=0.6
graphdog eval eval/docs.json --baseline eval/baseline.json --out eval/latest.json
```

A dataset is plain JSON — queries, the refs that answer them, optionally a grade
and the exact lines. `eval` runs them through the real search pipeline (not a
copy of it) and reports Recall@K, Precision@K, MRR, nDCG@K, evidence-line
accuracy and latency percentiles.

`--fail-under` sets a floor and `--baseline` compares against a stored report;
either exits **8** when breached, so a change that quietly makes search worse
fails a build instead of being noticed a month later.

## Japanese and multilingual

Works out of the box: CJK is indexed as character bigrams and everything
normalizes through NFKC, so `ＪＷＴ` and `JWT` match.

For paraphrase matching, opt in to a local ONNX model — no Python, no API key:

```console
npm install @huggingface/transformers
graphdog init docs --source ./docs --semantic
```

## Offline by default

No model download, no network, no service. The built-in embedder is lexical
rather than semantic and says so — `status` reports it, and searches carry a
warning pointing at the semantic option.

Requires Node 22.18+.
[Full documentation](https://github.com/4moda/graph-dog). MIT.
