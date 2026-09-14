/**
 * Index-term tokenization, shared by BM25 and the built-in embedder.
 *
 * One tokenizer for both signals keeps lexical behaviour consistent between
 * them. It is dependency-free and deterministic: the same text yields the same
 * tokens on every platform and Node build, which is what lets two people
 * rebuild the same corpus and get byte-identical indexes.
 */

/** Hiragana, katakana, CJK ideographs and halfwidth katakana. */
const CJK_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x3040, 0x30ff],
  [0x3400, 0x4dbf],
  [0x4e00, 0x9fff],
  [0xf900, 0xfaff],
  [0xff66, 0xff9d],
];

export function isCjk(codePoint: number): boolean {
  for (const [low, high] of CJK_RANGES) {
    if (codePoint >= low && codePoint <= high) return true;
  }
  return false;
}

const LATIN_TOKEN = /[0-9a-z_]+/g;
/** Split identifiers at case transitions: `getUserToken` into get, User, Token. */
const CAMEL_BOUNDARY = /(?<=[a-z0-9])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])/;
const WORD_CHAR = /[\p{L}\p{N}_]/u;

/**
 * Split text into index terms.
 *
 * Latin and numeric runs become whole words plus camelCase sub-words, so
 * `getUserToken` is reachable by `token`. CJK runs become character bigrams --
 * the standard dependency-free way to get usable Japanese recall without a
 * morphological analyzer -- and a single-character run is kept as a unigram so
 * one-character queries still match.
 *
 * Bigrams are a deliberate trade: they over-generate slightly compared with a
 * dictionary-based analyzer, costing a little precision and buying robustness
 * on domain vocabulary no dictionary has seen. A morphological tokenizer can
 * be layered in behind this same signature later without touching callers.
 */
export function tokenize(text: string): string[] {
  if (!text) return [];
  const normalized = text.normalize("NFKC");
  const tokens: string[] = [];
  let cjkRun = "";
  let otherRun = "";

  const flushCjk = (): void => {
    if (!cjkRun) return;
    const run = cjkRun;
    cjkRun = "";
    if (run.length === 1) {
      tokens.push(run);
      return;
    }
    for (let i = 0; i < run.length - 1; i += 1) tokens.push(run.slice(i, i + 2));
  };

  const flushOther = (): void => {
    if (!otherRun) return;
    const run = otherRun;
    otherRun = "";
    const pieces = run.split(CAMEL_BOUNDARY);
    for (const piece of pieces) {
      const lowered = piece.toLowerCase();
      LATIN_TOKEN.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = LATIN_TOKEN.exec(lowered)) !== null) tokens.push(match[0]);
    }
    if (pieces.length > 1) {
      // Index the joined identifier too, so `getUserToken` matches itself.
      tokens.push(run.toLowerCase());
    }
  };

  for (const char of normalized) {
    const codePoint = char.codePointAt(0) ?? 0;
    if (isCjk(codePoint)) {
      flushOther();
      cjkRun += char;
    } else if (WORD_CHAR.test(char)) {
      flushCjk();
      otherRun += char;
    } else {
      flushCjk();
      flushOther();
    }
  }
  flushCjk();
  flushOther();
  return tokens;
}

/** Term frequencies for one text. */
export function termFrequencies(text: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const token of tokenize(text)) counts.set(token, (counts.get(token) ?? 0) + 1);
  return counts;
}
