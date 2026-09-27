/**
 * D1 rejects a statement whose numbered placeholders have gaps ("Wrong number of parameter bindings")
 * though node:sqlite accepts them. Returns what is wrong with a generated statement, or null.
 */
export function denseProblem(sql: string, bindings: unknown[]): string | null {
  const stripped = sql.replace(/'(?:[^']|'')*'/g, "''");
  if (/\?(?!\d)/.test(stripped)) return "bare ? placeholder";
  const used = [...new Set([...stripped.matchAll(/\?(\d+)/g)].map(m => Number(m[1])))].sort((a, b) => a - b);
  const expected = used.map((_, i) => i + 1);
  if (used.join() !== expected.join()) return `placeholder numbers ${used.join(",")} are not 1..${used.length}`;
  if (bindings.length !== used.length) return `${used.length} placeholders but ${bindings.length} bindings`;
  return null;
}
