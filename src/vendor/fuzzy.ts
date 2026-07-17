// Vendored from anatomed-web/src/lib/data.ts (fuzzyMatchScored only).

export interface ScoredMatch {
  term: string;
  score: number;
}

/** Length-aware fuzzy match. Returns each candidate with a score in [0, 1] so
 *  callers can reject low-confidence substring traps (e.g. the query
 *  "foot bones" silently resolving to "Sesamoid bones of foot").
 *  - 1.00 — exact (case-insensitive) match
 *  - 0.90 — term starts with the query
 *  - q.length / lc.length, capped at 0.85 — query appears as a substring. */
export function fuzzyMatchScored(
  query: string,
  terms: string[],
  limit = 12,
): ScoredMatch[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const out: ScoredMatch[] = [];
  for (const t of terms) {
    const lc = t.toLowerCase();
    if (lc === q) out.push({ term: t, score: 1 });
    else if (lc.startsWith(q)) out.push({ term: t, score: 0.9 });
    else if (lc.includes(q)) {
      const ratio = q.length / lc.length;
      out.push({ term: t, score: Math.min(ratio, 0.85) });
    }
  }
  out.sort((a, b) => b.score - a.score);
  return out.slice(0, limit);
}
