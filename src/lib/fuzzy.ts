// Sublime-style fuzzy matching: characters in order, bonuses for word starts,
// consecutive runs and matches in the file name over the directory.

export type FuzzyResult = { score: number; indices: number[] };

export function fuzzy(query: string, target: string): FuzzyResult | null {
  if (!query) return { score: 0, indices: [] };
  const q = query.toLowerCase();
  const s = target.toLowerCase();
  const nameStart = Math.max(target.lastIndexOf('/'), target.lastIndexOf('\\')) + 1;
  // A contiguous match (best at a word start) beats any scattered one.
  if (!q.includes(' ')) {
    let at = -1;
    for (let i = s.indexOf(q); i >= 0; i = s.indexOf(q, i + 1)) {
      const before = target[i - 1];
      if (i === 0 || /[\s/\\_.\-:]/.test(before)) { at = i; break; }
      if (at < 0) at = i;
    }
    if (at >= 0) {
      const wordStart = at === 0 || /[\s/\\_.\-:]/.test(target[at - 1]);
      const score = 100 + q.length * 10 + (wordStart ? 40 : 0) + (at >= nameStart ? 20 : 0) - target.length * 0.05;
      return { score, indices: Array.from({ length: q.length }, (_, k) => at + k) };
    }
  }
  const indices: number[] = [];
  let score = 0;
  let qi = 0;
  let prev = -2;
  for (let i = 0; i < s.length && qi < q.length; i++) {
    if (s[i] !== q[qi]) continue;
    let bonus = 1;
    const before = target[i - 1];
    if (i === 0 || before === '/' || before === '\\' || before === '_' || before === '-' || before === '.' || before === ' ') bonus += 8;
    else if (target[i] !== s[i] && before && before === before.toLowerCase()) bonus += 6; // camelCase hump
    if (prev === i - 1) bonus += 5;
    if (i >= nameStart) bonus += 3;
    score += bonus;
    indices.push(i);
    prev = i;
    qi++;
  }
  if (qi < q.length) return null;
  score -= (target.length - nameStart) * 0.05; // prefer shorter names
  score -= nameStart * 0.01;
  return { score, indices };
}

export function rank<T>(items: T[], query: string, key: (t: T) => string, limit = 200) {
  const out: { item: T; score: number; indices: number[] }[] = [];
  for (const item of items) {
    const r = fuzzy(query, key(item));
    if (r) out.push({ item, ...r });
  }
  out.sort((a, b) => b.score - a.score);
  return out.slice(0, limit);
}
