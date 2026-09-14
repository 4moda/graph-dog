/**
 * What never gets indexed, and why.
 *
 * Two separate concerns live here:
 *
 * - **Noise**: build output, dependency trees and VCS internals. Skipping
 *   these is a performance and relevance decision.
 * - **Secrets**: private keys, `.env` files, credential stores. Skipping these
 *   is a safety decision, and every skip is *recorded with its reason* so an
 *   audit can show what was deliberately left out rather than leaving a gap
 *   nobody can account for.
 *
 * The secret list is heuristic and is not a substitute for not having secrets
 * in the tree. It is a floor, not a guarantee, and the manifest says so.
 */

/** Directory names never walked into. */
export const SKIP_DIRECTORIES: ReadonlySet<string> = new Set([
  ".git", ".hg", ".svn", ".jj",
  ".venv", "venv", "node_modules", "__pycache__", "vendor",
  ".mypy_cache", ".pytest_cache", ".ruff_cache", ".tox", ".nox",
  "dist", "build", "out", "target", ".next", ".nuxt", ".svelte-kit",
  ".gradle", ".idea", ".vscode", ".cache", "coverage",
  ".graphdog",
]);

/**
 * Filename patterns treated as secrets.
 *
 * Matched case-insensitively against both the basename and the full relative
 * path, so `config/prod.env` is caught as well as `.env`.
 */
export const SECRET_PATTERNS: readonly string[] = [
  "*.pem", "*.key", "*.p12", "*.pfx", "*.jks", "*.keystore", "*.kdbx", "*.ppk",
  "id_rsa", "id_dsa", "id_ecdsa", "id_ed25519", "*_rsa", "*_ed25519",
  ".env", ".env.*", "*.env",
  "*credential*", "*credentials*", "*secret*", "*secrets*", "*password*",
  ".npmrc", ".pypirc", ".netrc", ".htpasswd",
  "*token.json", "*service-account*.json", "*serviceaccount*.json",
  "*.jceks", "known_hosts", "authorized_keys",
];

/** Reasons recorded against a skipped file. Stable; additions only. */
export const ExclusionReason = {
  SECRET_PATTERN: "secret_pattern",
  FILE_TOO_LARGE: "file_too_large",
  EMPTY_FILE: "empty_file",
  UNREADABLE: "unreadable",
  UNSUPPORTED_TYPE: "unsupported_type",
  GIT_UNAVAILABLE: "git_unavailable",
} as const;

/** Default per-file ceiling. Larger files are recorded as excluded, not truncated. */
export const DEFAULT_MAX_FILE_BYTES = 8 * 1024 * 1024;

/**
 * Compile a glob to a regular expression.
 *
 * Supports `*` (within a segment), `**` (across segments) and `?`. Everything
 * else is escaped, so a pattern containing regex metacharacters matches
 * literally rather than doing something surprising.
 */
export function globToRegExp(pattern: string): RegExp {
  let source = "";
  for (let i = 0; i < pattern.length; i += 1) {
    const char = pattern[i];
    if (char === "*") {
      if (pattern[i + 1] === "*") {
        // `**/` consumes any number of leading segments, including none.
        if (pattern[i + 2] === "/") {
          source += "(?:.*/)?";
          i += 2;
        } else {
          source += ".*";
          i += 1;
        }
      } else {
        source += "[^/]*";
      }
    } else if (char === "?") {
      source += "[^/]";
    } else if (char !== undefined) {
      source += char.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${source}$`, "i");
}

const cache = new Map<string, RegExp>();

function compiled(pattern: string): RegExp {
  let expression = cache.get(pattern);
  if (expression === undefined) {
    expression = globToRegExp(pattern);
    cache.set(pattern, expression);
  }
  return expression;
}

/** Match a relative posix path against globs, trying the basename too. */
export function matchesAny(relativePath: string, patterns: readonly string[]): boolean {
  if (patterns.length === 0) return false;
  const basename = relativePath.slice(relativePath.lastIndexOf("/") + 1);
  return patterns.some(
    (pattern) => compiled(pattern).test(relativePath) || compiled(pattern).test(basename),
  );
}

export function isSecretPath(relativePath: string, extra: readonly string[] = []): boolean {
  return matchesAny(relativePath, [...SECRET_PATTERNS, ...extra]);
}

export function isSkippedDirectory(name: string): boolean {
  // Leading-dot directories are skipped wholesale: they are configuration and
  // tooling state, not the documents anyone means to search.
  return SKIP_DIRECTORIES.has(name) || name.startsWith(".");
}
