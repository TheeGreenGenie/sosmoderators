/** Iterative Levenshtein distance — O(m*n) time, O(min(m,n)) space. */
export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  // Keep the shorter string in the inner loop
  if (a.length > b.length) [a, b] = [b, a];

  const prev = Array.from({ length: a.length + 1 }, (_, i) => i);
  const curr = new Array<number>(a.length + 1);

  for (let j = 1; j <= b.length; j++) {
    curr[0] = j;
    for (let i = 1; i <= a.length; i++) {
      curr[i] =
        b[j - 1] === a[i - 1]
          ? (prev[i - 1] ?? 0)
          : 1 + Math.min(prev[i - 1] ?? 0, prev[i] ?? 0, curr[i - 1] ?? 0);
    }
    prev.splice(0, prev.length, ...curr);
  }

  return prev[a.length] ?? 0;
}
