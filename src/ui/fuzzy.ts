export interface FuzzyMatch {
  readonly score: number;
  readonly positions: readonly number[];
}

export interface FuzzyRun {
  readonly start: number;
  readonly length: number;
  readonly hit: boolean;
}

export interface FuzzyRank extends FuzzyMatch {
  readonly index: number;
}

export const FUZZY_START = 10;
export const FUZZY_BOUNDARY = 8;
export const FUZZY_CAMEL = 6;
export const FUZZY_DIGIT = 4;
export const FUZZY_CONSECUTIVE = 6;
export const FUZZY_SUBSTRING = 6;
export const FUZZY_EXACT_CASE = 2;
export const FUZZY_GAP_START = -3;
export const FUZZY_GAP_EXTEND = -1;
export const FUZZY_MAX_NEEDLE = 32;

const UNREACHABLE = -1_000_000_000;

const NEEDLE_SEPARATORS = new Set([' ', '_', '-']);
const HAYSTACK_SEPARATORS = new Set([' ', '_', '-', '.', '/', '(', ')', ',', ':']);

function isLowerAlpha(char: string): boolean {
  return char >= 'a' && char <= 'z';
}

function isUpperAlpha(char: string): boolean {
  return char >= 'A' && char <= 'Z';
}

function isAlpha(char: string): boolean {
  return isLowerAlpha(char) || isUpperAlpha(char);
}

function isDigit(char: string): boolean {
  return char >= '0' && char <= '9';
}

function charBonus(haystack: string, index: number): number {
  if (index === 0) return FUZZY_BOUNDARY;
  const prev = haystack[index - 1];
  const cur = haystack[index];
  if (HAYSTACK_SEPARATORS.has(prev)) return FUZZY_BOUNDARY;
  if (isLowerAlpha(prev) && isUpperAlpha(cur)) return FUZZY_CAMEL;
  if ((isDigit(prev) && isAlpha(cur)) || (isAlpha(prev) && isDigit(cur))) return FUZZY_DIGIT;
  return 0;
}

function matchable(needle: string, i: number, haystack: string, j: number): boolean {
  const n = needle[i];
  const h = haystack[j];
  if (NEEDLE_SEPARATORS.has(n)) return HAYSTACK_SEPARATORS.has(h);
  if (HAYSTACK_SEPARATORS.has(h)) return false;
  return n.toLowerCase() === h.toLowerCase();
}

function contiguousMatch(needle: string, haystack: string, start: number): FuzzyMatch | null {
  let score = FUZZY_SUBSTRING + FUZZY_CONSECUTIVE * (needle.length - 1) +
    (start === 0 ? FUZZY_START : 0);
  const positions: number[] = [];
  for (let i = 0; i < needle.length; i++) {
    const j = start + i;
    if (!matchable(needle, i, haystack, j)) return null;
    positions.push(j);
    score += charBonus(haystack, j) + (needle[i] === haystack[j] ? FUZZY_EXACT_CASE : 0);
  }
  return { score, positions };
}

export function fuzzyMatch(needle: string, haystack: string): FuzzyMatch | null {
  if (needle.length === 0) return { score: 0, positions: [] };
  if (needle.length > FUZZY_MAX_NEEDLE || needle.length > haystack.length) return null;

  let scan = 0;
  for (let i = 0; i < needle.length; i++) {
    let found = false;
    while (scan < haystack.length) {
      if (matchable(needle, i, haystack, scan)) {
        found = true;
        break;
      }
      scan++;
    }
    if (!found) return null;
    scan++;
  }

  const n = needle.length;
  const m = haystack.length;
  const parents: number[][] = [];
  let prevM = new Array<number>(m).fill(UNREACHABLE);
  let prevP = new Array<number>(m).fill(UNREACHABLE);
  let prevArgP = new Array<number>(m).fill(-1);

  for (let i = 0; i < n; i++) {
    const rowM = new Array<number>(m).fill(UNREACHABLE);
    const rowP = new Array<number>(m).fill(UNREACHABLE);
    const rowArgP = new Array<number>(m).fill(-1);
    const parent = new Array<number>(m).fill(-1);
    for (let j = 0; j < m; j++) {
      if (matchable(needle, i, haystack, j)) {
        const cell = charBonus(haystack, j) + (needle[i] === haystack[j] ? FUZZY_EXACT_CASE : 0);
        if (i === 0) {
          rowM[j] = cell + (j === 0 ? FUZZY_START : 0);
        } else if (j > 0) {
          let best = UNREACHABLE;
          let par = -1;
          if (prevM[j - 1] > UNREACHABLE / 2) {
            best = prevM[j - 1] + FUZZY_CONSECUTIVE;
            par = j - 1;
          }
          if (prevP[j - 1] > UNREACHABLE / 2 && prevP[j - 1] > best) {
            best = prevP[j - 1];
            par = prevArgP[j - 1];
          }
          if (par >= 0) {
            rowM[j] = best + cell;
            parent[j] = par;
          }
        }
      }
      if (j > 0) {
        const openGap = rowM[j - 1] + FUZZY_GAP_START;
        const extendGap = rowP[j - 1] + FUZZY_GAP_EXTEND;
        if (openGap >= extendGap) {
          rowP[j] = openGap;
          rowArgP[j] = j - 1;
        } else {
          rowP[j] = extendGap;
          rowArgP[j] = rowArgP[j - 1];
        }
      }
    }
    parents.push(parent);
    prevM = rowM;
    prevP = rowP;
    prevArgP = rowArgP;
  }

  let bestJ = -1;
  let bestScore = UNREACHABLE;
  for (let j = 0; j < m; j++) {
    if (prevM[j] > bestScore) {
      bestScore = prevM[j];
      bestJ = j;
    }
  }
  if (bestJ < 0) return null;

  const positions = new Array<number>(n);
  let cursor = bestJ;
  for (let i = n - 1; i >= 0; i--) {
    positions[i] = cursor;
    cursor = parents[i][cursor];
  }

  let best: FuzzyMatch = { score: bestScore, positions };
  for (let start = 0; start + n <= m; start++) {
    const candidate = contiguousMatch(needle, haystack, start);
    if (candidate !== null && candidate.score > best.score) best = candidate;
  }
  return best;
}

export function fuzzyRank(needle: string, haystacks: readonly string[]): readonly FuzzyRank[] {
  const ranks: FuzzyRank[] = [];
  for (let i = 0; i < haystacks.length; i++) {
    const match = fuzzyMatch(needle, haystacks[i]);
    if (match !== null) ranks.push({ ...match, index: i });
  }
  ranks.sort((a, b) => (b.score - a.score) || (a.index - b.index));
  return ranks;
}

export function highlightRuns(positions: readonly number[], length: number): readonly FuzzyRun[] {
  const runs: FuzzyRun[] = [];
  let k = 0;
  let cur = 0;
  while (cur < length) {
    const hit = positions[k] === cur;
    const start = cur;
    if (hit) {
      while (cur < length && positions[k] === cur) {
        cur++;
        k++;
      }
    } else {
      while (cur < length && positions[k] !== cur) cur++;
    }
    runs.push({ start, length: cur - start, hit });
  }
  return runs;
}
