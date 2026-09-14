# @graphdog/mcp

MCP server exposing a local [GraphDog](https://github.com/4moda/graph-dog)
corpus to AI agents. Search returns evidence — a file ref, an exact line range,
and a per-signal score breakdown — not a blob of text to trust.

## Setup

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

Build a corpus first:

```console
npx graphdog init docs --source ./docs
npx graphdog build
```

## Tools

| Tool | Returns |
|---|---|
| `search` | Ranked hits with refs, line ranges, snippets, per-signal scores |
| `explore` | The same, plus the graph neighbourhood connecting them |
| `read` | Verbatim source text for a ref |
| `status` | Document counts, freshness, whether the corpus is usable |
| `list_corpora` | Every corpus the server can see |
| `build_corpus` | Re-index. **Requires `--allow-write`** |

The intended loop: `search` → take a hit's `read_ref` → `read` it → quote with
a verifiable citation.

`search` and `explore` also take `corpora` (a list) or `all_corpora` (a
boolean) to search several corpora in one call. Hits come back as one ranked
list, merged by rank rather than by score, and each carries the `corpus` it came
from and its `corpus_rank` within that corpus. The response's `corpora` array
names every corpus considered, including any that could not be opened — a
skipped corpus never silently disappears from the answer.

There is deliberately no evaluation tool. Measuring retrieval quality is a
maintainer's job (`graphdog eval` in the CLI), not something an agent should
trigger in the middle of a task.

## Read-only by default

`build_corpus` is hidden unless the server is started with `--allow-write`. An
agent given a corpus to consult should not be able to rewrite it because a
document it read told it to.

## Options

```
-c, --corpus <name>   Corpus to serve when a call omits one
-C, --cwd <path>      Directory to resolve corpora from
    --allow-write     Expose build_corpus
-q, --quiet           Only log errors
-v, --verbose         Log debug detail
```

Logging goes to stderr; stdout carries only JSON-RPC.

## Behaviour worth relying on

- **An empty result is not an error.** `search` returns zero hits with a
  `no_sufficient_evidence` warning when the corpus does not contain the answer.
  That is the honest reply, and it should not be worked around by guessing.
- **Failures are typed.** Tool errors carry a stable `code` and a `remedy` where
  one exists, in `structuredContent`.
- **Identical to the CLI.** Both go through the same use cases and serializers;
  a test asserts byte equality.

Requires Node 22.18+. MIT.
