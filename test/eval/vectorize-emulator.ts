type Metadata = Record<string, unknown>;
type Values = number[] | Float32Array | Float64Array;
type Condition = unknown;
type Filter = Record<string, Condition>;

interface Entry {
  id: string;
  values: Float32Array;
  norm: number;
  metadata?: Metadata;
}

interface QueryOptions {
  topK?: number;
  filter?: Filter;
  returnMetadata?: boolean | "none" | "indexed" | "all";
  returnValues?: boolean;
}

function norm(values: Float32Array): number {
  let sum = 0;
  for (const value of values) sum += value * value;
  return Math.sqrt(sum);
}

function validateFilter(filter: Filter | undefined): void {
  if (!filter) return;
  for (const [field, condition] of Object.entries(filter)) {
    if (condition === null || typeof condition !== "object" || Array.isArray(condition)) continue;
    const operators = Object.entries(condition);
    if (!operators.length) throw new Error(`unsupported Vectorize filter for ${field}`);
    for (const [operator, operand] of operators) {
      if (!["$eq", "$ne", "$in", "$nin"].includes(operator)) {
        throw new Error(`unsupported Vectorize filter ${operator} for ${field}`);
      }
      if ((operator === "$in" || operator === "$nin") && !Array.isArray(operand)) {
        throw new Error(`invalid Vectorize filter ${operator} for ${field}`);
      }
    }
  }
}

function filterMatches(metadata: Metadata | undefined, filter: Filter | undefined): boolean {
  if (!filter) return true;
  return Object.entries(filter).every(([field, condition]) => {
    const value = metadata?.[field];
    if (condition !== null && typeof condition === "object" && !Array.isArray(condition)) {
      const operators = Object.entries(condition);
      return operators.every(([operator, operand]) => {
        switch (operator) {
          case "$eq": return value === operand;
          case "$ne": return value !== undefined && value !== operand;
          case "$in": return (operand as unknown[]).includes(value);
          case "$nin": return value !== undefined && !(operand as unknown[]).includes(value);
          default: return false;
        }
      });
    }
    return value === condition;
  });
}

/** Exact cosine search over float32 vectors. Equal scores sort by ascending ID. */
export class ExactVectorize {
  private readonly entries = new Map<string, Entry>();
  private readonly dimensions: number;
  private readonly maxTopK: number;
  private mutation = 0;

  constructor(options: { dimensions: number; maxTopK?: number }) {
    if (!Number.isInteger(options.dimensions) || options.dimensions < 1) throw new Error("invalid vector dimension");
    const maxTopK = options.maxTopK ?? 50;
    if (!Number.isInteger(maxTopK) || maxTopK < 1) throw new Error("invalid maxTopK");
    this.dimensions = options.dimensions;
    this.maxTopK = maxTopK;
  }

  private prepare(vectors: { id: string; values: Values; metadata?: Metadata }[]): Entry[] {
    return vectors.map(vector => {
      if (vector.values.length !== this.dimensions) {
        throw new Error(`vector ${vector.id}: dimension ${vector.values.length} != index ${this.dimensions}`);
      }
      const values = Float32Array.from(vector.values);
      return { id: vector.id, values, norm: norm(values), metadata: vector.metadata && structuredClone(vector.metadata) };
    });
  }

  async upsert(vectors: { id: string; values: Values; metadata?: Metadata }[]) {
    for (const entry of this.prepare(vectors)) this.entries.set(entry.id, entry);
    return { mutationId: `m-${++this.mutation}` };
  }

  async insert(vectors: { id: string; values: Values; metadata?: Metadata }[]) {
    const prepared = this.prepare(vectors);
    const ids = new Set<string>();
    for (const entry of prepared) {
      if (this.entries.has(entry.id) || ids.has(entry.id)) throw new Error(`vector ${entry.id} already exists`);
      ids.add(entry.id);
    }
    for (const entry of prepared) this.entries.set(entry.id, entry);
    return { mutationId: `m-${++this.mutation}` };
  }

  async deleteByIds(ids: string[]) {
    for (const id of ids) this.entries.delete(id);
    return { mutationId: `m-${++this.mutation}` };
  }

  async getByIds(ids: string[]) {
    return ids.flatMap(id => {
      const entry = this.entries.get(id);
      return entry ? [{ id, values: Array.from(entry.values), ...(entry.metadata && { metadata: structuredClone(entry.metadata) }) }] : [];
    });
  }

  async query(values: Values, options: QueryOptions = {}) {
    const topK = options.topK ?? 5;
    if (!Number.isInteger(topK) || topK < 1 || topK > this.maxTopK) {
      throw new Error(`topK ${topK} is outside 1..${this.maxTopK}`);
    }
    if (values.length !== this.dimensions) throw new Error(`query dimension ${values.length} != index ${this.dimensions}`);
    validateFilter(options.filter);
    const probe = Float32Array.from(values);
    const probeNorm = norm(probe);
    const scored: { entry: Entry; score: number }[] = [];
    for (const entry of this.entries.values()) {
      if (!filterMatches(entry.metadata, options.filter)) continue;
      let dot = 0;
      for (let i = 0; i < probe.length; i++) dot += probe[i] * entry.values[i];
      scored.push({ entry, score: probeNorm === 0 || entry.norm === 0 ? 0 : dot / (probeNorm * entry.norm) });
    }
    scored.sort((a, b) => b.score - a.score || (a.entry.id < b.entry.id ? -1 : a.entry.id > b.entry.id ? 1 : 0));
    const returnMetadata = options.returnMetadata === true || options.returnMetadata === "all" || options.returnMetadata === "indexed";
    const matches = scored.slice(0, topK).map(({ entry, score }) => ({
      id: entry.id,
      score,
      ...(returnMetadata && entry.metadata && { metadata: structuredClone(entry.metadata) }),
      ...(options.returnValues && { values: Array.from(entry.values) }),
    }));
    return { count: matches.length, matches };
  }

  async describe() { return { dimensions: this.dimensions, vectorCount: this.entries.size }; }
  get size() { return this.entries.size; }
}
