# Homebrew tap

GraphDog's primary channel. The tap is `4moda/homebrew-graphdog`, so installing
is one line:

```console
brew install 4moda/graphdog/graphdog
```

A tap is a repository Homebrew draws packages from -- the vocabulary is beer
brewing throughout, and a tap is what you pour from. Its name *must* be
`homebrew-graphdog`, because the one-line form above resolves `4moda/graphdog`
to `github.com/4moda/homebrew-graphdog` mechanically. It holds
`Formula/graphdog.rb` and nothing else.

This directory holds the formula GraphDog publishes into that tap. The tap is a
separate repository, for the reason recorded in
[distribution.md](../../docs/design/distribution.md#why-a-second-repository-and-why-that-name):
every user's `brew update` re-fetches a tap, and this repository's history is
28 MB, 25 of which is the evaluation suite's PDFs.

## Creating the tap, once

```console
gh repo create 4moda/homebrew-graphdog --public \
  --description "Homebrew formula for GraphDog"
git clone https://github.com/4moda/homebrew-graphdog
cd homebrew-graphdog
mkdir Formula
cp ../graph-dog/packaging/homebrew/graphdog.rb Formula/graphdog.rb
git add Formula/graphdog.rb && git commit -m "Add the graphdog formula" && git push
```

`brew tap-new 4moda/graphdog` scaffolds the same thing locally, with a bottle-
building workflow, if that is wanted later. Neither is needed until GraphDog is
published to npm: the formula points at a registry tarball, so a tap created
before the first `npm publish` installs nothing.

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
