// Minimal in-process unified diff (zero dependencies).
//
// Why this exists: `consolidate --dry-run` must show what it *would* change without
// touching git. The previous implementation ran `git add -A` and `git diff --staged`,
// which staged the user's entire working tree as a side effect (C7). Computing the diff
// from the in-memory change set keeps a dry run side-effect-free.
//
// The algorithm is a plain LCS over lines, grouped into hunks with 3 lines of context.
// It is O(n·m) in the number of lines, which is fine for note-sized files.

interface Op {
  type: 'eq' | 'del' | 'add';
  line: string;
}

/** Longest-common-subsequence edit script between two line arrays. */
function lcsOps(a: string[], b: string[]): Op[] {
  const n = a.length;
  const m = b.length;
  // dp[i][j] = LCS length of a[i..] and b[j..]
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ type: 'eq', line: a[i] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      ops.push({ type: 'del', line: a[i] });
      i++;
    } else {
      ops.push({ type: 'add', line: b[j] });
      j++;
    }
  }
  while (i < n) ops.push({ type: 'del', line: a[i++] });
  while (j < m) ops.push({ type: 'add', line: b[j++] });
  return ops;
}

/** Split into lines without a trailing empty element for a final newline. */
function toLines(s: string): string[] {
  if (s === '') return [];
  return s.replace(/\n$/, '').split('\n');
}

/**
 * Render a unified diff between `before` and `after` for a vault-relative `path`.
 * Returns an empty string when the contents are identical.
 */
export function unifiedDiff(path: string, before: string, after: string, context = 3): string {
  if (before === after) return '';
  const a = toLines(before);
  const b = toLines(after);
  const ops = lcsOps(a, b);

  const changed: number[] = [];
  ops.forEach((op, idx) => {
    if (op.type !== 'eq') changed.push(idx);
  });
  if (changed.length === 0) return '';

  // Group changed op indices into hunks, merging when their context windows overlap.
  const hunks: { start: number; end: number }[] = [];
  let start = Math.max(0, changed[0] - context);
  let end = Math.min(ops.length - 1, changed[0] + context);
  for (let k = 1; k < changed.length; k++) {
    const c = changed[k];
    if (c - context <= end + 1) {
      end = Math.min(ops.length - 1, c + context);
    } else {
      hunks.push({ start, end });
      start = Math.max(0, c - context);
      end = Math.min(ops.length - 1, c + context);
    }
  }
  hunks.push({ start, end });

  const out: string[] = [`--- a/${path}`, `+++ b/${path}`];
  for (const h of hunks) {
    let aStart = 1;
    let bStart = 1;
    for (let i = 0; i < h.start; i++) {
      if (ops[i].type !== 'add') aStart++;
      if (ops[i].type !== 'del') bStart++;
    }
    let aCount = 0;
    let bCount = 0;
    for (let i = h.start; i <= h.end; i++) {
      if (ops[i].type !== 'add') aCount++;
      if (ops[i].type !== 'del') bCount++;
    }
    out.push(`@@ -${aStart},${aCount} +${bStart},${bCount} @@`);
    for (let i = h.start; i <= h.end; i++) {
      const op = ops[i];
      out.push(op.type === 'eq' ? ` ${op.line}` : op.type === 'del' ? `-${op.line}` : `+${op.line}`);
    }
  }
  return out.join('\n') + '\n';
}
