/**
 * A small fuzzy matcher for the pickers: the query must appear in the text as
 * a case-insensitive subsequence. Among all ways to place it, the best one
 * wins, scored with bonuses for matching at the start, at word boundaries
 * (after a space, `-`, `_`, `/`, `.`, `:` or at a camelCase hump) and for
 * consecutive characters, and a small penalty for every skipped character.
 * Dynamic programming keeps it O(query × text).
 */

export interface FuzzyMatch {
  readonly score: number;
  /** Indices into the text of the matched characters, ascending. */
  readonly positions: ReadonlyArray<number>;
}

const SCORE_MATCH = 16;
const BONUS_START = 12;
const BONUS_BOUNDARY = 10;
const BONUS_CAMEL = 8;
const BONUS_CONSECUTIVE = 12;
const PENALTY_GAP = 1;
const PENALTY_LEADING = 0.5;
const MAX_LEADING_PENALTY = 6;

const SEPARATORS = new Set([" ", "-", "_", "/", ".", ":", "\\", "(", "[", "#", "@"]);

function boundaryBonus(text: string, index: number): number {
  if (index === 0) return BONUS_START;
  const previous = text[index - 1] ?? "";
  if (SEPARATORS.has(previous)) return BONUS_BOUNDARY;
  const current = text[index] ?? "";
  const isUpper = (char: string) => char !== char.toLowerCase() && char === char.toUpperCase();
  if (isUpper(current) && !isUpper(previous)) return BONUS_CAMEL;
  if (/[0-9]/.test(current) && !/[0-9]/.test(previous)) return BONUS_CAMEL;
  return 0;
}

/** The best match of `query` in `text`, or null if it is not a subsequence. An empty query matches with score 0. */
export function fuzzyMatch(query: string, text: string): FuzzyMatch | null {
  const needle = query.replace(/\s+/g, "").toLowerCase();
  if (needle === "") return { score: 0, positions: [] };
  const haystack = text.toLowerCase();
  const m = needle.length;
  const n = haystack.length;
  if (m > n) return null;

  // Quick rejection: is it a subsequence at all?
  let probe = 0;
  for (let j = 0; j < n && probe < m; j++) if (haystack[j] === needle[probe]) probe += 1;
  if (probe < m) return null;

  const bonus = new Array<number>(n);
  for (let j = 0; j < n; j++) bonus[j] = boundaryBonus(text, j);

  // score[i][j]: best score with needle[i] matched at haystack[j]; -Infinity if impossible.
  const score: Float64Array[] = [];
  const from: Int32Array[] = [];
  for (let i = 0; i < m; i++) {
    const row = new Float64Array(n).fill(Number.NEGATIVE_INFINITY);
    const back = new Int32Array(n).fill(-1);
    const char = needle[i];
    // Running max of score[i-1][k] + PENALTY_GAP * k, for gaps.
    let best = Number.NEGATIVE_INFINITY;
    let bestAt = -1;
    for (let j = 0; j < n; j++) {
      if (i > 0 && j > 0) {
        const previousRow = score[i - 1] as Float64Array;
        const candidate = (previousRow[j - 1] as number) + PENALTY_GAP * (j - 1);
        if (candidate > best) {
          best = candidate;
          bestAt = j - 1;
        }
      }
      if (haystack[j] !== char) continue;
      const own = SCORE_MATCH + (bonus[j] as number);
      if (i === 0) {
        row[j] = own - Math.min(MAX_LEADING_PENALTY, PENALTY_LEADING * j);
        continue;
      }
      const previousRow = score[i - 1] as Float64Array;
      // Consecutive: needle[i-1] matched right before.
      const consecutive =
        j > 0 && (previousRow[j - 1] as number) > Number.NEGATIVE_INFINITY
          ? (previousRow[j - 1] as number) + BONUS_CONSECUTIVE
          : Number.NEGATIVE_INFINITY;
      // Gapped: needle[i-1] matched at some k < j, minus the skipped characters.
      const gapped =
        best > Number.NEGATIVE_INFINITY ? best - PENALTY_GAP * (j - 1) : Number.NEGATIVE_INFINITY;
      if (consecutive === Number.NEGATIVE_INFINITY && gapped === Number.NEGATIVE_INFINITY) continue;
      if (consecutive >= gapped) {
        row[j] = own + consecutive;
        back[j] = j - 1;
      } else {
        row[j] = own + gapped;
        back[j] = bestAt;
      }
    }
    score.push(row);
    from.push(back);
  }

  const last = score[m - 1] as Float64Array;
  let end = -1;
  let total = Number.NEGATIVE_INFINITY;
  for (let j = 0; j < n; j++) {
    if ((last[j] as number) > total) {
      total = last[j] as number;
      end = j;
    }
  }
  if (end === -1) return null;
  const positions = new Array<number>(m);
  let j = end;
  for (let i = m - 1; i >= 0; i--) {
    positions[i] = j;
    j = (from[i] as Int32Array)[j] as number;
  }
  // Prefer shorter texts slightly when everything else is equal.
  return { score: total - n * 0.01, positions };
}

export interface Ranked<T> {
  readonly item: T;
  /** Position in the input list. */
  readonly index: number;
  readonly match: FuzzyMatch;
}

/**
 * Items matching `query`, best first (ties keep input order). With an empty
 * query every item matches and the order is unchanged.
 */
export function fuzzyFilter<T>(
  items: ReadonlyArray<T>,
  query: string,
  text: (item: T) => string,
): ReadonlyArray<Ranked<T>> {
  const ranked: Ranked<T>[] = [];
  items.forEach((item, index) => {
    const match = fuzzyMatch(query, text(item));
    if (match !== null) ranked.push({ item, index, match });
  });
  if (query.trim() === "") return ranked;
  return ranked.sort((a, b) => b.match.score - a.match.score || a.index - b.index);
}
