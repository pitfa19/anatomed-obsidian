// Vendored from anatomed-web/src/lib/data.ts (fuzzyMatchScored only).
// KEEP IN SYNC across anatomed-mcp / anatomed-obsidian / anatomed-web.

export interface ScoredMatch {
  term: string;
  score: number;
}

/** A prefix match whose remainder starts with one of these is a *sub-entity* of
 *  the query, not the query itself: "Deltoid muscle" -> "Deltoid muscle-Humeral
 *  insertion". The source model names attachment placeholders this way, so
 *  without this guard every composite muscle resolves to one of its insertions. */
const SUBENTITY_EXTENSION = /^\s*[-,(]/;
const SUBENTITY_SCORE = 0.3;

/** A substring hit that starts mid-word is weak evidence ("brain" in "Midbrain"). */
const WORD_INTERIOR_PENALTY = 0.55;

/** Edit-distance and token tiers only fire when the literal tiers found nothing
 *  convincing, and their results are shaded slightly so a literal match of equal
 *  strength always wins. */
const APPROX_MIN = 0.72;
const APPROX_WEIGHT = 0.95;
const MAX_EDIT_FRACTION = 0.34;

/**
 * How far apart two strings may be, and it depends on whether anything else
 * corroborates the match.
 *
 * A fraction alone is too permissive: at 0.34 an eight-letter query is allowed
 * three edits, which is how `Placenta` silently resolved to `Planta` (the sole
 * of the foot). Two edits, one close candidate, so the ambiguity margin never
 * fired and nothing warned the student.
 *
 * But an absolute cap alone is too strict, because `arterie` -> `artery` is
 * also two edits in a seven-letter word and is a typo anyone might make. The
 * two cases are indistinguishable by edit count; what separates them is
 * **corroboration**. `Placenta` is a whole-string match standing on its own, so
 * it must be near-exact. `arterie` is one token of `femoral arterie`, and the
 * token tier disqualifies a candidate unless *every* other query token also
 * finds a near-match — `femoral` matching exactly is independent evidence that
 * this is the right structure, so the tolerance can stay loose there.
 */
function maxEdits(len: number, corroborated: boolean): number {
  const fraction = Math.ceil(len * MAX_EDIT_FRACTION);
  return corroborated ? fraction : Math.min(fraction, len <= 8 ? 1 : len <= 12 ? 2 : 3);
}

/** A prefix match must account for a real share of the term. Without a floor the
 *  decay below has an asymptote at 0.65, so a six-letter query scores 0.65
 *  against a forty-five-letter name that merely begins with it — which is how
 *  `Insula` reached `Insular branches of middle cerebral artery (M2)`, a
 *  different structure in a different system. Below the floor the match is
 *  treated as the weak evidence it is. */
const PREFIX_MIN_COVERAGE = 0.3;

/** Per-token floor for the token tier. Slightly below APPROX_MIN because a single
 *  wrong token is far weaker evidence than the same edit distance spread over a
 *  whole phrase — but high enough that "lobe" never matches "bone" (0.50). */
const TOKEN_MIN = 0.7;

/** Below this length the approximate tiers are noise (every short string is a
 *  small edit away from dozens of others) and they are also the hot path for
 *  the Obsidian autocomplete, which re-ranks the whole catalogue per keystroke.
 *  Literal prefix/substring matching still applies at any length. */
const MIN_APPROX_QUERY_LEN = 4;

/** Words that carry no discriminating power in an anatomical query. */
const STOPWORDS = new Set(['of', 'the', 'a', 'an', 'in', 'on', 'to', 'and']);

function isWordStart(lc: string, i: number): boolean {
  return i === 0 || /[\s\-(,/]/.test(lc[i - 1]);
}

/** Damerau-Levenshtein with an early-abort band: returns `max + 1` as soon as the
 *  best achievable distance exceeds `max`, so most candidates cost almost nothing. */
function editDistance(a: string, b: string, max: number): number {
  const al = a.length;
  const bl = b.length;
  if (Math.abs(al - bl) > max) return max + 1;
  if (al === 0) return bl;
  if (bl === 0) return al;

  let prev2 = new Array<number>(bl + 1).fill(0);
  let prev = new Array<number>(bl + 1);
  let cur = new Array<number>(bl + 1);
  for (let j = 0; j <= bl; j++) prev[j] = j;

  for (let i = 1; i <= al; i++) {
    cur[0] = i;
    let rowBest = cur[0];
    for (let j = 1; j <= bl; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        v = Math.min(v, prev2[j - 2] + 1);
      }
      cur[j] = v;
      if (v < rowBest) rowBest = v;
    }
    if (rowBest > max) return max + 1;
    const spare = prev2;
    prev2 = prev;
    prev = cur;
    cur = spare;
  }
  return prev[bl];
}

/** Normalised edit similarity in [0, 1]; 0 when the strings are too far apart.
 *  `corroborated` marks a per-token comparison inside a multi-token query, where
 *  the other tokens carry independent evidence — see `maxEdits`. */
function editSimilarity(q: string, t: string, corroborated = false): number {
  const len = Math.max(q.length, t.length);
  if (len === 0) return 0;
  const max = maxEdits(len, corroborated);
  const d = editDistance(q, t, max);
  return d > max ? 0 : 1 - d / len;
}

function splitTokens(s: string): string[] {
  return s
    .split(/[\s\-(),/]+/)
    .filter((w) => w.length > 0 && !STOPWORDS.has(w));
}

/** The candidate list is the same ~3,200 catalogue terms on every call (and the
 *  Obsidian autocomplete calls this per keystroke), so tokenising them once and
 *  reusing the result is the difference between ~14 ms and ~4 ms per query. The
 *  cache is bounded by the catalogue size. */
const TOKEN_CACHE = new Map<string, string[]>();

function tokenize(s: string): string[] {
  const hit = TOKEN_CACHE.get(s);
  if (hit) return hit;
  const tokens = splitTokens(s);
  TOKEN_CACHE.set(s, tokens);
  return tokens;
}

/** Every query token must find a near-match among the term's tokens. Handles word
 *  order, filler words and per-word typos together: "arch of the aorta" against
 *  "Aortic arch", "sapenous vein" against "Great saphenous vein". Terms carrying
 *  many *extra* tokens are discounted, so a short query cannot claim a long name. */
function tokenSimilarity(qTokens: string[], t: string): number {
  if (qTokens.length === 0) return 0;
  const tTokens = tokenize(t);
  if (tTokens.length === 0) return 0;

  let total = 0;
  const used = new Set<number>();
  for (const qt of qTokens) {
    let best = 0;
    let bestIdx = -1;
    for (let i = 0; i < tTokens.length; i++) {
      if (used.has(i)) continue;
      const tt = tTokens[i];
      const s = tt === qt ? 1 : editSimilarity(qt, tt, true);
      if (s > best) {
        best = s;
        bestIdx = i;
      }
    }
    if (best < TOKEN_MIN) return 0; // an unmatched query token disqualifies the term
    if (bestIdx >= 0) used.add(bestIdx);
    total += best;
  }
  const mean = total / qTokens.length;
  const coverage = used.size / tTokens.length; // how much of the term the query accounts for
  return mean * (0.55 + 0.45 * coverage);
}

/** Length- and structure-aware fuzzy match. Returns each candidate with a score in
 *  [0, 1] so callers can reject low-confidence traps.
 *  - 1.00 — exact (case-insensitive)
 *  - ~0.65–0.90 — term starts with the query, decaying as the term outgrows it
 *  - 0.30 — term starts with the query but continues into a sub-entity ("…-Insertion")
 *  - ≤0.85 — query appears as a substring, halved when it starts mid-word
 *  - approximate tiers (edit distance, then per-token) for misspellings and
 *    reordered/padded phrasings, consulted only when the literal tiers are weak. */
export function fuzzyMatchScored(
  query: string,
  terms: string[],
  limit = 12,
): ScoredMatch[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const qTokens = tokenize(q);
  const out: ScoredMatch[] = [];

  for (const t of terms) {
    const lc = t.toLowerCase();
    let score = 0;

    if (lc === q) {
      score = 1;
    } else if (lc.startsWith(q)) {
      score =
        SUBENTITY_EXTENSION.test(lc.slice(q.length)) ||
        q.length / lc.length < PREFIX_MIN_COVERAGE
          ? SUBENTITY_SCORE
          : 0.9 - 0.25 * (1 - q.length / lc.length);
    } else {
      const at = lc.indexOf(q);
      if (at >= 0) {
        const ratio = Math.min(q.length / lc.length, 0.85);
        score = isWordStart(lc, at) ? ratio : ratio * WORD_INTERIOR_PENALTY;
      }
    }

    // Approximate tiers — only when nothing literal was convincing.
    //
    // Whole-string edit distance is restricted to SINGLE-TOKEN queries. Across a
    // phrase it is far too permissive: "Frontal lobe" -> "Frontal bone" is only two
    // characters, but it is a different organ system entirely. Multi-word queries
    // go through the token tier instead, which requires *every* query token to find
    // a near-match, so a wholly wrong word disqualifies the candidate.
    if (score < APPROX_MIN && q.length >= MIN_APPROX_QUERY_LEN) {
      if (qTokens.length <= 1) {
        const es = editSimilarity(q, lc);
        if (es >= APPROX_MIN) score = Math.max(score, es * APPROX_WEIGHT);
      } else {
        const ts = tokenSimilarity(qTokens, lc);
        if (ts >= APPROX_MIN) score = Math.max(score, ts * APPROX_WEIGHT);
      }
    }

    if (score > 0) out.push({ term: t, score });
  }

  out.sort((a, b) => b.score - a.score);
  return out.slice(0, limit);
}
