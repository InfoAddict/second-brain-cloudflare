/**
 * Dense placeholder allocator. D1 rejects a statement whose numbered placeholders
 * have gaps ("?1, ?3" bound with two values), while node:sqlite accepts it, so every
 * generated statement allocates through here: the first distinct value is ?1, the
 * next ?2, and a repeated value reuses its number.
 */
export class Params {
  private list: unknown[] = [];
  private seen = new Map<unknown, number>();

  add(value: unknown): string {
    let n = this.seen.get(value);
    if (n === undefined) {
      this.list.push(value);
      n = this.list.length;
      this.seen.set(value, n);
    }
    return `?${n}`;
  }

  values(): unknown[] {
    return this.list;
  }
}
