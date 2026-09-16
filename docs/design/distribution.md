# Distribution and lifecycle

How GraphDog gets onto a machine, into an agent, up to date, and back off again.

**Built:** `graphdog install --platform <name>`, the refresh hooks,
`graphdog uninstall` with `--purge`, `graphdog doctor`, and the Homebrew formula
in [`packaging/homebrew/`](../../packaging/homebrew/). **Not yet:** the tap
repository itself, Kiro's agent hooks, and moving extras and model caches out of
the install directory.

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

### Why a second repository, and why that name

A *tap* is a repository Homebrew draws packages from -- the whole vocabulary is
beer brewing: a **formula** is a recipe, the **cellar** is where installs are
kept, a **keg** is one of them, a **bottle** is a prebuilt one, and a **tap** is
what you pour from. `brew tap` adds another source to pour from.

**The name is not decoration.** The one-line form resolves `user/repo` to
`github.com/user/homebrew-repo`, mechanically. So `4moda/graphdog/graphdog`
requires a repository called `homebrew-graphdog`; `graphdog-brew` or
`graph-dog` cannot serve it.

**Any name works with the long form**, because the local tap name and the remote
URL are independent:

```console
brew tap 4moda/graphdog https://github.com/4moda/graph-dog
brew install graphdog
```

That would let this repository be its own tap, with the formula at
`Formula/graphdog.rb`. It is rejected for a reason specific to this repository:
**a tap is cloned onto every user's machine and re-fetched by every `brew
update`**, and GraphDog's history is 28 MB, 25 MB of which is the evaluation
suite's government PDFs. Shipping those to somebody who wanted a search tool
contradicts everything `uninstall --purge` is careful about. A tap holding one
formula is a few kilobytes.

So: a separate repository, named `homebrew-graphdog` because that is what buys
the one-line install, holding nothing but `Formula/graphdog.rb`. The formula's
source of truth stays here, and releasing copies one generated file.

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

### `graphdog install --platform <name> [--project]` -- built

Connects GraphDog to an agent: registers the MCP server and adds short
instructions telling the agent to search before it reads. One command per
platform, as with Graphify, but as a flag rather than a subcommand per platform.
The first three:

| Platform | `--platform` | MCP registration | Instructions |
|---|---|---|---|
| Claude Code | `claude` | `.mcp.json` with `--project`, `~/.claude.json` otherwise | a marker-delimited block in `CLAUDE.md`, or `~/.claude/CLAUDE.md` |
| GitHub Copilot | `copilot` | `.vscode/mcp.json`, whose container is `servers` rather than `mcpServers`. Project scope only | its own file, `.github/instructions/graphdog.instructions.md` |
| Kiro | `kiro` | `.kiro/settings/mcp.json`. Project scope only | its own file, `.kiro/steering/graphdog.md` |

These are the locations code-review-graph already writes to in this repository,
which is the evidence they are right.

A scope a platform does not have is **refused, naming the one to use** -- Kiro
reads steering from the project, and Copilot's user-scope registration differs
between VS Code and the Copilot CLI. Writing to a plausible-looking path instead
would leave somebody with an integration that silently does nothing.

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
  Cellar path -- which an upgrade replaces -- and not `npx`, which would make an
  agent's first search a download. The subcommand rather than the `graphdog-mcp`
  binary: that one ships in `@graphdog/mcp`, which `npm install -g graphdog`
  does not put on anyone's `PATH`, so registering it would be an integration
  that fails at the first search. `graphdog` now depends on `@graphdog/mcp` and
  serves the protocol itself.
- **Read-only by default.** `--allow-write` stays an explicit choice at install
  time, as it is for the MCP server today.
- **Steer, never block.** No hook that stops an agent reading a file.
- `--dry-run` shows every file and key it would write.

### Keeping the index current -- built, except Kiro's hooks

Part of `graphdog install --platform <name>`, not a separate step: connecting an
agent and keeping the thing it searches current are the same job.

The trigger is always the same -- run `graphdog update` -- and it is told nothing
about what changed. The update works that out, and since it costs about two
seconds on a 5,000-document corpus with nothing to do, working it out is cheaper
than arranging to be told.

**What differs is the mechanism, and it is whatever the platform actually has:**

| Platform | Mechanism | What it does |
|---|---|---|
| Claude Code | hooks in `.claude/settings.json` | `SessionStart` runs an update when a session opens; `Stop` runs one when a turn that may have edited files ends |
| Kiro | agent hooks | the same two moments -- **not written yet**: which of Kiro's events correspond to these is unconfirmed, and a guess would be a hook that silently never fires |
| GitHub Copilot | instructions | no hook mechanism exists, so the instruction file tells the agent to refresh when GraphDog says the corpus is stale |

The command is `graphdog update --all --quiet || true`. `--all` because a search
may reach any corpus visible from here, and a refresh that took the first of
three would be the silent staleness the trigger exists to prevent.

**Where hooks exist, use hooks.** They are deterministic: they fire whether or
not the agent thought to, and they cost no tokens. `Stop` rather than a
`PostToolUse` on every `Edit` and `Write`, which would run several updates
inside one turn and make the agent wait for each; `SessionStart` as well as
`Stop`, because between two sessions a person pulls, switches branch and edits
in an editor, and `Stop` alone would leave the first search of a session reading
an index from last time.

**Where they do not, steering is not a guess.** Every search response already
carries the corpus's freshness, and a stale one carries a `stale_corpus`
warning naming what changed. So the instruction is a rule about an observable
fact, not a hope: *if a search says the corpus is stale, call `update_corpus`
and search again.* Copilot gets that in
`.github/instructions/graphdog.instructions.md`, and it is worth having on the
hook platforms too, as the thing that catches a tree changed mid-turn.

That needs a tool an agent may call. `build_corpus` is behind `--allow-write`
today, and should stay there: it takes `full`, which is minutes of work, and the
gate exists so that a document an agent reads cannot talk it into rewriting the
index. So **split it** -- `update_corpus`, incremental only, no arguments beyond
the corpus name, exposed by default; `build_corpus` with `full` left behind the
gate. The worst an injected instruction can then do is make the agent re-index
its own configured sources, which changes nothing on disk.

**Git hooks are an option, not the default.** `graphdog install --git-hooks`
writes marker-delimited `post-commit`, `post-merge`, `post-checkout` and
`post-rewrite` hooks for someone who uses GraphDog from a terminal rather than
through an agent. They are not installed by `--platform`, for five reasons:

- **The consumer is the agent.** An index needs to be current when an agent
  searches, and the agent's own lifecycle says exactly when that is. A pull or a
  rebase between sessions is picked up by `SessionStart`, before anything reads
  the index -- which is the coverage a git hook was there for.
- **One action fires several hooks.** `git commit --amend` fires `post-commit`
  and `post-rewrite`. An interactive rebase of ten commits fires `post-checkout`
  repeatedly and `post-rewrite` at the end. A pull that rebases fires both
  again. Add an agent that made the commit and its `Stop` fires too. None of
  this is *wrong* -- updates are idempotent, and two running at once were
  measured to finish and agree -- but it is the same two seconds paid five or
  fifteen times for one action. `--debounce <seconds>`, skipping an update when
  one finished that recently, is the mitigation, and it is one more thing to get
  right for a trigger that is already redundant.
- **The execution environment is not the one GraphDog was installed in.**
  `.git/hooks` scripts run under whatever shell and `PATH` the caller happens to
  have. Git for Windows runs them in its bundled bash, which may not resolve an
  npm `graphdog.cmd`; a hook written from WSL for a repository on `/mnt/c` names
  a Linux path that Git for Windows cannot run, and the reverse; GUI clients --
  VS Code, GitHub Desktop, JetBrains -- run hooks without the login shell's
  `PATH`, so `graphdog` is simply not found; and a hook file that picks up CRLF
  or loses its executable bit on a Windows-mounted filesystem fails with `bad
  interpreter`. Each of these is a *silent* failure to refresh. An agent hook
  runs inside the agent, which is running in the environment the user installed
  GraphDog into.
- **`.git/hooks` is not GraphDog's to hold.** It cannot be committed, husky,
  lefthook and pre-commit take it over, and `--no-verify` skips it.
- **It covers nothing for a corpus that is not a git working tree** -- a folder
  of PDFs, an imported archive.

An agent hook is one entry in a list of them, so GraphDog appends its own and,
on the way out, removes that element rather than the key -- deleting the key
would take every other tool's hook for the same event with it.

**No file watcher**, for the reasons a hook is better than one: a watcher is a
daemon to start, supervise and remember to stop, and it fires on saves that mean
nothing -- an editor's swap file, a half-written line, a build directory. Every
trigger above is a moment where the tree has reached a state worth indexing.

Common to all of them:

- **A trigger never fails the thing that triggered it.** The command is
  `graphdog update --quiet || true`: an agent's turn does not end in an error,
  and a commit is not rejected, because an index could not be refreshed.
- **Firing twice is wasteful, never wrong.** An update is idempotent and leaves
  what a rebuild would, so a doubled trigger costs time and changes nothing.
  `doctor` reports how long the last update took, which is how anyone notices
  they are paying for it twice.
- **Concurrent triggers are safe.** A `Stop` hook and a git hook can fire
  together; the corpus is WAL with a busy timeout, and two updates running at
  once both complete and leave the same corpus.
- **Marker-delimited or its own key**, like the instruction blocks, so
  uninstall removes exactly what was written and nothing beside it.
- **A repository's hook manager wins.** husky, lefthook and pre-commit own
  `.git/hooks` and regenerate it, so GraphDog's lines would vanish at their next
  install -- silently. `--git-hooks` detects them and **refuses, naming the line
  to add** to their configuration. Writing that configuration for them is still
  to do.
- Recorded in the same ledger as everything else, and removed by
  `graphdog uninstall`.

### `graphdog uninstall [--platform <name>] [--project] [--purge --yes]` -- built

Takes back what `install` wrote.

- Every write is recorded in a ledger, `~/.graphdog/installed.json`: file, key or
  marker, agent, scope, and the version that wrote it. Uninstall removes exactly
  those.
- Because GraphDog's files have fixed names and its blocks have markers, a
  project-scope integration can also be removed from a clone the ledger has
  never seen -- a teammate's checkout.
- A file GraphDog created and that is empty afterwards is deleted; a file it only
  added to is left otherwise untouched -- byte for byte what was there before,
  which the specs assert as a round trip rather than by inspection. A directory
  the install created and that is empty afterwards goes too; one that still
  holds somebody else's file stays.
- **No platform named means every platform, and both scopes.** "Take it off"
  that leaves the other scope behind is the uninstall people complain about.
- `--purge` additionally deletes GraphDog's own data: home-workspace corpora
  whole, and the project's built indexes. On its own it lists what it would
  delete, with sizes, and **refuses**; `--yes` confirms it. A confirmation flag
  rather than a prompt, because agents and scripts drive this command too and a
  prompt they cannot answer is a hang. (Optional extras and the model cache join
  this once they move to `~/.graphdog/`.)
- **Never deleted, even with `--purge`:** a project's corpus configs
  (`.graphdog/corpora/*/graphdog.json`). They are the project's files, and may be
  committed.
- `--dry-run` shows what would go.

### `graphdog doctor` -- built

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

It exits non-zero (5) when something is **broken** -- a file an install wrote
that has since gone, a corpus built against another schema, a database that
cannot be read -- so it can run in CI or after an upgrade script. A **warning**,
such as an integration an older version wrote, is worth knowing and is not a
failure.

It never loads an embedding model. A semantic corpus's compatibility is decided
by comparing recorded identities, and instantiating the embedder to find that
out could mean a download -- from the command whose whole job is telling you
whether things are in order.

### `graphdog extras add <semantic|pdf|docx>` -- not built

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
| Agent hooks, when that lands | the agent's own settings (Claude Code's `SessionStart` and `Stop`) | `graphdog uninstall` |
| Git hooks, only if `--git-hooks` was asked for | `.git/hooks/*`, marker-delimited, or the hook manager's config | `graphdog uninstall` |
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

- the tap is `4moda/homebrew-graphdog`; the formula and its release procedure
  live in [`packaging/homebrew/`](../../packaging/homebrew/)
- the first platforms are Claude Code, GitHub Copilot and Kiro
- integration is a CLI command, `graphdog install --platform <name>`
- keeping the index current uses each platform's own mechanism -- hooks where
  they exist, instructions acting on reported staleness where they do not -- and
  is part of `install`, not a step of its own
- git hooks are opt-in (`--git-hooks`), for use outside an agent; there is no
  file watcher

## Open decisions

- where Copilot's MCP registration goes: VS Code's `.vscode/mcp.json`, Copilot
  CLI's configuration, or both
- which Kiro agent-hook events correspond to Claude Code's `SessionStart` and
  `Stop`
- whether `SessionStart` should refresh before the session's first search or in
  the background behind it: two seconds of latency when a session opens against
  a first search that may read last session's index
- whether the separate `graphdog-mcp` binary is worth keeping now that
  `graphdog mcp` exists, or should be retired at the next major version
