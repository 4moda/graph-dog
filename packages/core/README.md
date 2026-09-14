# @graphdog/core

Domain model, use cases and adapters for [GraphDog](https://github.com/4moda/graph-dog)
— an agent-native portable knowledge index.

Most users want the [`graphdog`](https://www.npmjs.com/package/graphdog) CLI or
the [`@graphdog/mcp`](https://www.npmjs.com/package/@graphdog/mcp) server. This
package is for embedding GraphDog in your own TypeScript program.

```console
npm install @graphdog/core
```

## Usage

Go through `openCorpus` rather than constructing adapters yourself — it is the
composition root, and it is what guarantees every interface assembles a corpus
identically.

```ts
import { openCorpus, searchCorpus, assertCompatible } from "@graphdog/core";

const corpus = await openCorpus({ corpus: "docs", cwd: process.cwd() });
try {
  // Refuse to search a corpus built with a different model or chunker.
  assertCompatible(corpus.store, corpus.config, corpus.embedding);

  const result = await searchCorpus(
    { query: "JWT rotation", topK: 5 },
    {
      store: corpus.store,
      config: corpus.config,
      embedding: corpus.embedding,
      freshness: corpus.freshness(),
      reranker: await corpus.reranker(),
    },
  );

  if (result.noEvidence) {
    console.log("not in the corpus");
  }
  for (const hit of result.hits) {
    console.log(hit.ref, hit.location.startLine, hit.scores.final);
  }
} finally {
  corpus.close();
}
```

Building:

```ts
import { buildCorpus, openCorpus } from "@graphdog/core";

const corpus = await openCorpus({ corpus: "docs" });
try {
  const report = await buildCorpus({ full: true }, {
    store: corpus.store,
    config: corpus.config,
    sources: corpus.sources,
    extractors: corpus.extractors,
    embedding: corpus.embedding,
    clock: corpus.clock,
    hasher: corpus.hasher,
    readFile: corpus.readFile,
  });
  if (report.status === "partial") console.warn(report.failures);
} finally {
  corpus.close();
}
```

## Serializing

To produce the same JSON the CLI and MCP server return, use the mappers:

```ts
import { toHitDto, toFreshnessDto, toWarningDtos } from "@graphdog/core";

const payload = {
  schema_version: "1",
  contract_version: "1.0",
  kind: "search",
  query: result.query,
  corpus: result.corpus,
  freshness: toFreshnessDto(result.freshness),
  hits: result.hits.map(toHitDto),
  suggested_queries: result.suggestedQueries,
  strategy: result.strategy,
  stats: result.stats,
  warnings: toWarningDtos(result.warnings),
};
```

See [the contract](https://github.com/4moda/graph-dog/blob/main/docs/design/contract.md).

## Optional capabilities

| Feature | Install |
|---|---|
| Semantic embeddings, cross-encoder reranking | `npm install @huggingface/transformers` |
| PDF extraction | `npm install pdfjs-dist` |
| DOCX extraction | `npm install mammoth` |

Without them the default lexical embedder is used, and files needing a missing
extractor are reported as build failures rather than silently skipped.

## Evaluation

`evaluateCorpus` runs a judged dataset through `searchCorpus` and scores it with
the pure metric functions in `domain/service/metrics.ts` — `recallAtK`,
`precisionAtK`, `reciprocalRank`, `ndcgAtK`, `evidenceAccuracy`, `aggregate`.
`checkGates` turns the result into a pass or a fail against thresholds and a
stored baseline.

The metrics take a ranked list and a set of judgments and nothing else, so they
are usable on their own and testable against worked examples. Throughout them,
`null` means *unmeasurable* and never *zero*.

## Layering

`domain` (pure) ← `application` (use cases and ports) ← `infrastructure`
(adapters), wired in `composition`. Infrastructure adapters are intentionally
not exported: use `openCorpus`.

Requires Node 22.18+. MIT.
