# The formula published to the tap `4moda/homebrew-graphdog`.
#
# Regenerate it for a release with:
#   node scripts/make-homebrew-formula.mjs 0.2.0 > packaging/homebrew/graphdog.rb
# which fills in the version and the published tarball's SHA-256, then copy it
# into the tap as `Formula/graphdog.rb`.
class Graphdog < Formula
  desc "Local evidence search for AI agents, with exact citations"
  homepage "https://github.com/4moda/graph-dog"
  url "https://registry.npmjs.org/graphdog/-/graphdog-0.1.0.tgz"
  sha256 "0000000000000000000000000000000000000000000000000000000000000000"
  license "MIT"

  # Not `node@22`: current Node satisfies the >=22.18 requirement, and pinning a
  # major would strand the formula the moment Homebrew retires that keg.
  depends_on "node"

  def install
    # `std_npm_args` installs into libexec and ignores lifecycle scripts, which
    # GraphDog needs none of: it ships a prebuilt dist/ and has no native addon
    # -- SQLite is node:sqlite, built into Node itself.
    system "npm", "install", *std_npm_args
    bin.install_symlink libexec.glob("bin/*")
  end

  def caveats
    <<~EOS
      Connect GraphDog to an agent:
        graphdog install --platform claude --project

      Before `brew uninstall graphdog`, run:
        graphdog uninstall

      Homebrew removes only what it installed itself, and GraphDog writes into
      your agents' configuration, which is not that.
    EOS
  end

  test do
    # A real build and search rather than `--version`: it exercises node:sqlite,
    # which is exactly where an incompatible Node major would fail, and that is
    # the failure a version check would miss.
    (testpath/"docs").mkpath
    (testpath/"docs/keys.md").write("# Keys\n\nPublic keys are published at the JWKS endpoint.\n")
    system bin/"graphdog", "init", "demo", "--source", "./docs"
    system bin/"graphdog", "build", "--quiet"
    assert_match "docs/keys.md", shell_output("#{bin}/graphdog search JWKS --json")

    # The MCP server the install command registers has to be on PATH too.
    assert_match "graphdog", shell_output("#{bin}/graphdog mcp --version")
  end
end
