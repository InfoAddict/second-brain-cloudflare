import { createHash } from "node:crypto";

/** Largest absolute component; also rejects empty and non-finite input. */
function peak(v: readonly number[], name: string): number {
  if (v.length === 0) throw new Error(`${name}: empty vector`);
  let max = 0;
  for (const x of v) {
    if (!Number.isFinite(x)) throw new Error(`${name}: vector components must be finite`);
    max = Math.max(max, Math.abs(x));
  }
  if (max === 0) throw new Error(`${name}: zero vector has no direction`);
  return max;
}

/** Scales by the peak component first, so squaring 1e200 (or 1e-200) neither overflows nor underflows. */
function unit(v: readonly number[], name = "vector"): number[] {
  const max = peak(v, name);
  const scaled = v.map(x => x / max);
  const n = Math.sqrt(scaled.reduce((s, x) => s + x * x, 0));
  return scaled.map(x => x / n);
}
const dot = (a: readonly number[], b: readonly number[]) => a.reduce((s, x, i) => s + x * b[i], 0);

/** Cosine similarity in [-1, 1]. Throws on zero vectors, mismatched dimensions, and non-finite input. */
export function cosine(a: readonly number[], b: readonly number[]): number {
  if (a.length !== b.length) throw new Error(`cosine: dimension mismatch (${a.length} vs ${b.length})`);
  return Math.max(-1, Math.min(1, dot(unit(a, "cosine a"), unit(b, "cosine b"))));
}

/** Deterministic pseudo-random unit vector; carries no semantics. */
export function hashVector(text: string, dims: number): number[] {
  const out: number[] = [];
  for (let counter = 0; out.length < dims; counter++) {
    const digest = createHash("sha256").update(`${counter}:${text}`).digest();
    for (let i = 0; i + 1 < digest.length && out.length < dims; i += 2) out.push(digest.readUInt16BE(i) / 32768 - 1);
  }
  return unit(out);
}

/** A unit vector whose cosine with `query` is exactly `targetCosine`, for exact-cosine test fixtures. */
export function controlledVector(query: readonly number[], targetCosine: number, id: string): number[] {
  if (query.length < 2) throw new Error(`controlledVector: needs dimension >= 2 to have an orthogonal direction (got ${query.length})`);
  if (!Number.isFinite(targetCosine) || Math.abs(targetCosine) > 1) throw new Error(`controlledVector: targetCosine must be in [-1, 1] (got ${targetCosine})`);
  const q = unit(query, "controlledVector query");
  const r = hashVector(`controlled:${id}`, q.length);
  const proj = dot(r, q);
  const orthogonal = unit(r.map((x, i) => x - proj * q[i]), "controlledVector orthogonal");
  const s = Math.sqrt(Math.max(0, 1 - targetCosine * targetCosine));
  return q.map((x, i) => targetCosine * x + s * orthogonal[i]);
}
