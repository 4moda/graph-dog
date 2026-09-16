# Homebrew tap

GraphDog's primary channel. The tap is `4moda/homebrew-graphdog`, so installing
is one line:

```console
brew install 4moda/graphdog/graphdog
```

A tap is a repository whose name *must* be `homebrew-graphdog`, holding
`Formula/graphdog.rb`. This directory holds the formula GraphDog publishes into
it; the tap is a separate repository and is not part of this one.

## Releasing

1. Publish to npm: `npm publish --workspace packages/core --workspace packages/mcp --workspace packages/cli`.
2. Regenerate the formula, which fetches the published tarball and hashes it:

   ```console
   node scripts/make-homebrew-formula.mjs 0.2.0 > packaging/homebrew/graphdog.rb
   ```

3. Copy it into the tap as `Formula/graphdog.rb` and push.
4. Verify against a clean prefix:

   ```console
   brew install --build-from-source 4moda/graphdog/graphdog
   brew test graphdog
   brew audit --strict --online 4moda/graphdog/graphdog
   ```

The checksum is fetched rather than typed on purpose: a formula with a stale one
fails for every user at once, and the mistake is invisible in review.

## homebrew-core

The tap comes first. homebrew-core has an acceptance policy GraphDog does not
meet yet — it wants a project with a user base and a release history — and the
formula that goes there is this same file with the tap-specific parts removed.

## What Homebrew does not do

`brew uninstall graphdog` removes what Homebrew installed: the CLI and the MCP
server. It does not remove GraphDog's registrations in your agents'
configuration, because Homebrew never put them there. `--zap` does not help;
that is a cask feature.

So the order is `graphdog uninstall` first, then `brew uninstall graphdog`. The
formula's caveats say so at install time, which is the only moment anyone reads
them.
