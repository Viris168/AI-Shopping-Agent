/** The usual constant from the RRF paper; damps the gap between rank 1 and rank 2. */
export const RRF_K = 60;

export interface Fused {
  id: string;
  score: number;
}

/**
 * Reciprocal Rank Fusion: each list adds 1 / (k + rank) for every id it contains. Uses ranks
 * only, so keyword scores (ts_rank, ILIKE hits) and cosine similarity never have to be compared.
 * Ties keep first-seen order, so the first list wins them.
 */
export function rrf(rankings: string[][], k = RRF_K): Fused[] {
  const scores = new Map<string, number>();
  for (const ranking of rankings) {
    ranking.forEach((id, i) => {
      scores.set(id, (scores.get(id) ?? 0) + 1 / (k + i + 1));
    });
  }
  return [...scores]
    .map(([id, score]) => ({ id, score }))
    .sort((a, b) => b.score - a.score);
}
