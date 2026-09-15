# Distribution and lifecycle

How GraphDog gets onto a machine, into an agent, up to date, and back off again.
This is planned, not built; today the only channel is `npm install -g graphdog`,
and connecting an agent means editing its MCP config by hand.

The goal is the product shape Graphify has shown works, not its feature list:
one install, one command to connect an agent, one command to upgrade, and an
uninstall that takes back everything GraphDog put anywhere -- with a single
command that says what that is.

## What Graphify does

From its [README](https://github.com/Graphify-Labs/graphify) as of September 2026:

| Step | Graphify |
|---|---|
| Install | `uv tool install graphifyy` (pipx and pip also work) |
| Connect an agent | `graphify install`, or `graphify <platform> install` -- `claude`, `codex`, `cursor`, `gemini` and more; `--project` writes committable files into the current repository instead of the user's configuration |
| What that writes | per platform: an instruction file (`CLAUDE.md`, `AGENTS.md`, `GEMINI.md`, `.cursor/rules/…`), a skill file, and for some platforms a hook that steers the agent to the graph before it reads files; `--strict` makes that hook block the first read |
| Keep it current | `graphify hook install`: post-commit and post-checkout rebuilds, plus a merge driver for the committed `graph.json` |
| Upgrade | `uv tool upgrade graphifyy`, then `graphify install` again |
| Uninstall | `graphify uninstall` for every platform, `graphify <platform> uninstall` for one, `graphify hook uninstall` for the hooks; `--purge` also deletes the generated `graphify-out/`, which is otherwise kept |
| See what is installed | `graphify hook status` for the hooks; no single command for the rest |

**Worth copying:** install and uninstall are symmetric per agent; user scope and
project scope are separate; generated data survives an uninstall unless purge is
asked for; project-scoped files are meant to be committed.

**Worth doing differently:**

- one command, `graphdog doctor`, that reports everything installed and anything
  broken, instead of piecing it together per platform
- uninstall driven by a record of what was written, so it removes exactly that
- upgrades that notice integrations written by an older version, instead of
  relying on the user to remember to re-run install
- the MCP registration points at the installed binary, never at a downloader
  such as `npx`, so an agent runs the version the user installed, offline
- steer agents towards search; never block a read

## Channels

| Channel | For | Upgrade | Remove |
|---|---|---|---|
| **Homebrew** (primary) | macOS and Linux, including WSL | `brew upgrade graphdog` | `graphdog uninstall`, then `brew uninstall graphdog` |
| npm | Windows without WSL, CI, `npx` one-offs | `npm update -g graphdog` | `graphdog uninstall`, then `npm uninstall -g graphdog` |

Both install the same npm packages and get the same lifecycle commands.

## Homebrew

A tap first -- `4moda/homebrew-graphdog`, so that installing is one line -- and
homebrew-core once GraphDog meets its acceptance policy:

```console
brew install 4moda/graphdog/graphdog
```

The formula follows Homebrew's guidance for npm-published CLIs: it depends on
`node` and installs the published tarball with `std_npm_args`.

```ruby
class Graphdog < Formula
  desc "Local evidence search for AI agents, with exact citations"
  homepage "https://github.com/4moda/graph-dog"
  url "https://registry.npmjs.org/graphdog/-/graphdog-0.2.0.tgz"
  sha256 "…"
  license "MIT"

  depends_on "node"

  def install
    system "npm", "install", *std_npm_args
    bin.install_symlink libexec.glob("bin/*")
  end

  def caveats
    <<~EOS
      Connect GraphDog to an agent:
        graphdog install --platform claude --project
      Before `brew uninstall graphdog`, run `graphdog uninstall`:
      Homebrew removes only what it installed itself.
    EOS
  end

  test do
    (testpath/"docs/keys.md").write "# Keys\n\nPublic keys are published at the JWKS endpoint.\n"
    system bin/"graphdog", "init", "demo", "--source", "./docs"
    system bin/"graphdog", "build", "--quiet"
    assert_match "docs/keys.md", shell_output("#{bin}/graphdog search JWKS --json")
  end
end
```

Why this is straightforward for GraphDog in particular:

- **Nothing to compile.** SQLite is `node:sqlite`, built into Node, so there is
  no native addon and no Python build dependency.
- **No install scripts.** `std_npm_args` ignores lifecycle scripts by default;
  GraphDog ships prebuilt `dist/` and needs none.
- **A functional test, not `--version`.** Homebrew asks for a test that exposes
  an incompatible Node major version. Building and searching a corpus exercises
  `node:sqlite`, which is exactly where an old Node would fail.
- **`depends_on "node"`, not `node@22`.** Current Node satisfies the
  `>=22.18` requirement; a versioned dependency only if a future Node breaks
  something and upstream documents it.

**One install gives both the CLI and the MCP server.** The formula installs the
`graphdog` package, so that package depends on `@graphdog/mcp` and offers it as
`graphdog mcp`. The three packages stay separate; this is only a dependency.

**Releases:** a version tag publishes `@graphdog/core`, `@graphdog/mcp` and
`graphdog` to npm in dependency order, then a workflow writes the new tarball's
URL and SHA-256 into the tap, whose CI runs `brew install` and `brew test` on
macOS and Linux. Homebrew's documentation leaves this automation to the project.

**What Homebrew does not do.** `brew uninstall` removes what Homebrew installed,
and nothing else; `--zap` exists only for casks. Agent configurations,
instruction files, hooks and data are GraphDog's to remove, which is why
`graphdog uninstall` exists and why the caveats mention it.

## Lifecycle commands

### `graphdog install --platform <name> [--project]`

Connects GraphDog to an agent: registers the MCP server and adds short
instructions telling the agent to search before it reads. One command per
platform, as with Graphify, but as a flag rather than a subcommand per platform.
The first three:

| Platform | `--platform` | MCP registration | Instructions |
|---|---|---|---|
| Claude Code | `claude` | `.mcp.json` in the project; the user's configuration otherwise | a marker-delimited block in `CLAUDE.md` |
| GitHub Copilot | `copilot` | to be confirmed: VS Code's `.vscode/mcp.json`, Copilot CLI's configuration, or both | its own file, `.github/instructions/graphdog.instructions.md` |
| Kiro | `kiro` | `.kiro/settings/mcp.json` in the project; the user's Kiro settings otherwise | its own file, `.kiro/steering/graphdog.md` |

These are the locations code-review-graph already writes to in this repository,
which is the evidence they are right; the Copilot MCP target is the one still to
check.

- **User scope** by default, in the agent's own configuration. **Project scope**
  with `--project`: files in the repository -- for Claude Code, `.mcp.json` and
  `CLAUDE.md` -- meant to be committed so the whole team gets the same setup.
- **Its own file wherever the platform reads several** (Copilot, Kiro), so
  uninstalling is deleting that file. Where the platform reads one shared file
  (`CLAUDE.md`), a **marker-delimited block** (`<!-- graphdog -->` …
  `<!-- /graphdog -->`) that coexists with other tools' blocks --
  code-review-graph has its own in the same file -- and never touches anything
  outside its markers. Both carry the version that wrote them.
- **The MCP registration runs `graphdog mcp`** from `PATH`, not a Homebrew
  Cellar path, so it survives upgrades, and not `npx`, so it never downloads.
- **Read-only by default.** `--allow-write` stays an explicit choice at install
  time, as it is for the MCP server today.
- **Steer, never block.** No hook that stops an agent reading a file.
- `--dry-run` shows every file and key it would write.

### `graphdog uninstall [--platform <name>] [--project] [--purge]`

Takes back what `install` wrote.

- Every write is recorded in a ledger, `~/.graphdog/installed.json`: file, key or
  marker, agent, scope, and the version that wrote it. Uninstall removes exactly
  those.
- Because GraphDog's files have fixed names and its blocks have markers, a
  project-scope integration can also be removed from a clone the ledger has
  never seen -- a teammate's checkout.
- A file GraphDog created and that is empty afterwards is deleted; a file it only
  added to is left otherwise untouched.
- `--purge` additionally deletes GraphDog's own data after listing it with sizes
  and asking: home-workspace corpora, optional extras, the model cache. With
  `--project`, it also deletes the project's built indexes.
- **Never deleted, even with `--purge`:** a project's corpus configs
  (`.graphdog/corpora/*/graphdog.json`). They are the project's files, and may be
  committed.
- `--dry-run` shows what would go.

### `graphdog doctor`

One report of everything installed and anything wrong:

```
graphdog 0.2.0 (homebrew), node 24.x
home        ~/.graphdog: 3 corpora, 120 MB
extras      semantic (@huggingface/transformers 4.2.0), models 450 MB
agents      claude   project /repo  mcp ok  instructions ok (0.2.0)
            kiro     project /repo  mcp ok  steering written by 0.1.0
                     -> graphdog install --platform kiro --refresh
hooks       /repo post-commit ok
corpora     docs: schema 2 needed, built with 1 -> graphdog build --full --corpus docs
```

It exits non-zero when something is broken -- a registration pointing at a
command that no longer exists, a corpus this version cannot read -- so it can
run in CI or after an upgrade script.

### `graphdog extras add <semantic|pdf|docx>`

Optional capabilities are optional npm packages today, installed next to
GraphDog. Under Homebrew that place is the Cellar, which an upgrade replaces, so
extras move to a directory GraphDog manages -- `~/.graphdog/extras/` -- and
optional modules are resolved from there. Downloaded models move to
`~/.graphdog/models/` for the same reason. Both survive `brew upgrade`;
`graphdog extras remove` and `uninstall --purge` delete them.

## What lives where

| What | Where | Removed by |
|---|---|---|
| CLI and MCP server | Homebrew prefix, or npm's global directory | `brew uninstall` / `npm uninstall -g` |
| MCP registrations | `.mcp.json`, `.kiro/settings/mcp.json`, Copilot's MCP configuration | `graphdog uninstall` |
| Instructions | GraphDog's own files (`.github/instructions/graphdog.instructions.md`, `.kiro/steering/graphdog.md`) and its block in `CLAUDE.md` | `graphdog uninstall` |
| Git hooks, when that lands | `.git/hooks/*`, marker-delimited | `graphdog uninstall` |
| Ledger | `~/.graphdog/installed.json` | `graphdog uninstall`, last |
| Home corpora, imported archives included | `~/.graphdog/corpora/` | `graphdog uninstall --purge` |
| Extras and model cache | `~/.graphdog/extras/`, `~/.graphdog/models/` | `graphdog extras remove`, `--purge` |
| Project indexes | `<repo>/.graphdog/corpora/*/corpus.sqlite3` | `graphdog uninstall --purge --project` |
| Project corpus configs | `<repo>/.graphdog/corpora/*/graphdog.json` | never -- the project's own |

`$GRAPHDOG_HOME` replaces `~/.graphdog` throughout.

## The procedures, end to end

**Install**

```console
brew install 4moda/graphdog/graphdog
cd your-project
graphdog init docs --source ./docs && graphdog build
graphdog install --platform claude --project
graphdog doctor
```

**Upgrade**

```console
brew upgrade graphdog
graphdog doctor                  # integrations or corpora that need attention
graphdog install --refresh       # re-sync what doctor flagged
brew pin graphdog                # to hold a version instead
```

**Uninstall**

```console
graphdog uninstall --dry-run     # see what would go
graphdog uninstall               # agent integrations and hooks
graphdog uninstall --purge       # also corpora, extras and models
brew uninstall graphdog
brew untap 4moda/graphdog        # if nothing else comes from the tap
```

## Decided

- the tap is `4moda/homebrew-graphdog`
- the first platforms are Claude Code, GitHub Copilot and Kiro
- integration is a CLI command, `graphdog install --platform <name>`

## Open decisions

- where Copilot's MCP registration goes: VS Code's `.vscode/mcp.json`, Copilot
  CLI's configuration, or both
- whether `graphdog mcp` replaces the separate `graphdog-mcp` binary or sits
  beside it
