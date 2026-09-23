import { createHash } from "node:crypto";

const norm = (v: readonly number[]) => Math.hypot(...v);
const unit = (v: readonly number[]) => { const n = norm(v); return v.map(x => x / n); };
const dot = (a: readonly number[], b: readonly number[]) => a.reduce((s, x, i) => s + x * b[i], 0);

export const cosine = (a: readonly number[], b: readonly number[]) => dot(a, b) / (norm(a) * norm(b));

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
  const q = unit(query);
  const r = hashVector(`controlled:${id}`, q.length);
  const proj = dot(r, q);
  const orthogonal = unit(r.map((x, i) => x - proj * q[i]));
  const s = Math.sqrt(Math.max(0, 1 - targetCosine * targetCosine));
  return q.map((x, i) => targetCosine * x + s * orthogonal[i]);
}
