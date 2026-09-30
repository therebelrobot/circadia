// Shared deterministic PRNG (RFC-0001 Appendix A #9).
//
// The same small LCG was duplicated in `benchmarks/generate-vault.ts` and
// `eval/generate-fixture.ts` (both seeded 42). It is extracted here so the REM pass can
// reuse it too. The algorithm is byte-for-byte the original: the eval fixture hash must
// not change, so do not "improve" the constants or the divisor.

/**
 * Small deterministic PRNG (LCG). Returns a function yielding a number in [0, 1].
 * `s / 0xffffffff` can return exactly 1 when the state is 0xffffffff; callers that index
 * an array must clamp (see `pickIndex`).
 */
export function makeRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0xffffffff;
  };
}

/** Uniform index in [0, n) from an rng that may return 1.0. */
export function pickIndex(rng: () => number, n: number): number {
  if (n <= 0) return 0;
  const i = Math.floor(rng() * n);
  return i >= n ? n - 1 : i;
}
