# Contributing

## Getting set up

```console
npm install          # installs all three workspaces
npm test             # runs every spec
npm run typecheck    # strict TypeScript across the monorepo
npm run build        # compiles all packages
npm run eval         # measures retrieval against the built-in dataset
```

Node 22.18 or newer. Tests run directly on TypeScript source via Node's native
type-stripping — there is no build step before testing and no test framework.

## Conventions

### Naming

| Thing | Style | Example |
|---|---|---|
| File names | kebab-case | `sqlite-corpus-store.ts` |
| Classes and types | UpperCamelCase | `SqliteCorpusStore`, `SearchResponseDto` |
| Functions and variables | lowerCamelCase | `searchCorpus`, `minDenseSimilarity` |
| Constants | SCREAMING_SNAKE_CASE | `DEFAULT_CHUNKING`, `SCHEMA_VERSION` |
| JSON fields | snake_case | `start_line`, `read_ref` |

JSON is snake_case because those documents are read by other tools, not by
JavaScript.

### Layering

Dependencies point inward only:

```
infrastructure → application → domain
```

- **domain** — pure. No IO, no clock, no randomness, no Node built-ins beyond
  language basics. Anything ambient is injected.
- **application** — use cases and ports. Never imports an adapter.
- **infrastructure** — adapters implementing ports.
- **composition** — the only place that sees both sides.

A pull request that imports SQLite from a use case, or `node:crypto` from the
domain, will be sent back. The layering is what makes the algorithm testable and
the two front ends impossible to drift apart.

### Tests

Every source file has a colocated `*.spec.ts`. Test behaviour, not
implementation: a spec should read as a statement of what the module guarantees.

```
src/domain/service/chunker.ts
src/domain/service/chunker.spec.ts
```

Run one file while iterating:

```console
node --test packages/core/src/domain/service/chunker.spec.ts
```

Shared test doubles live in `__fixtures__/` directories, excluded from the
published build.

### Node type-stripping constraints

Specs run directly on source, so the language subset is limited:

- no parameter properties (`constructor(private x: T)`) — declare fields
- no `enum` — use a `const` object with `as const`
- no `namespace`, no decorators

Relative imports carry `.ts` extensions; `rewriteRelativeImportExtensions`
emits `.js` at build time.

### Writing to streams

`stdout` is reserved for results: JSON contract output in the CLI, JSON-RPC
frames in the MCP server. **Never log to stdout.** Logging goes through the
injected `Logger`, which writes to stderr.

## Things that are not negotiable

These are the properties the project exists to provide. Changing one needs a
discussion, not just a passing test:

1. **Evidence is verifiable.** Every hit carries a ref and an exact line range,
   and `read` returns that span unmodified. Never truncate stored text.
2. **Errors are never success.** A failure gets a typed error and an exit code.
   A partial build reports `partial`. An empty result says so.
3. **Determinism.** Two builds of the same corpus produce identical output. No
   sampling, no `localeCompare`, no unordered iteration affecting results.
4. **Compatibility is refused, not degraded.** A corpus whose identities do not
   match is rejected with a remedy, never searched anyway.
5. **CLI and MCP return identical results.** Both go through the same use cases
   and the same mappers. A test asserts byte equality.
6. **The default install is offline and dependency-light.** New required
   dependencies need a strong justification; optional capabilities go behind
   optional peer dependencies.
7. **Ranking changes are measured, not argued.** A change to retrieval,
   chunking, fusion or the graph lands with a before-and-after from `npm run
   eval`. If it improves the numbers, raise `eval/baseline.json` in the same
   commit; if it lowers one, say so in the message and explain what it buys.

## Adding things

**A source adapter** — implement `SourceReader`, register it in
`source-reader-factory.ts`. Record what you skip and why.

**An extractor** — implement `ContentExtractor`, register it in
`extractor-registry.ts`. Emit page breaks for paginated formats. Import heavy
dependencies lazily and fail with the install command.

**An embedding model** — implement `EmbeddingModel`. The `id` must change
whenever anything that changes the vectors changes, including prompt prefixes.
Declare an honest `minUsefulSimilarity`.

**A contract field** — add it to `contracts.ts` and the mapper beside it, update
`docs/design/contract.md`, and add a spec. Additions are fine; removals and
semantic changes bump `contract_version`.

**An evaluation query** — add it to `eval/graphdog-docs.json` and re-record
`eval/baseline.json` in the same commit, since adding a query moves every
aggregate. Judge whole sections rather than exact passages: chunk boundaries
move, and the metric should measure retrieval, not the chunker.

**A metric** — the pure function goes in `domain/service/metrics.ts` with worked
examples in its spec. `null` means *unmeasurable*, never *zero*: a fabricated
zero moves the headline number for no reason.

## Commits and pull requests

Explain *why* in the message, not just what. The code says what changed; a
future reader needs the reasoning. Keep the test suite green and the typecheck
clean.
