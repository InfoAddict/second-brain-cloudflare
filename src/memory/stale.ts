import { withoutVolatility } from "./volatility";

export const STALE_AS_OF = "stale:as-of";

export function hasStaleAsOf(tags: string[]): boolean {
  return tags.includes(STALE_AS_OF);
}

export function withStaleAsOf(tags: string[]): string[] {
  if (tags.includes(STALE_AS_OF)) return tags;
  return [...tags, STALE_AS_OF];
}

export function withoutStaleAsOf(tags: string[]): string[] {
  return tags.filter(t => t !== STALE_AS_OF);
}

/** Strip staleness/volatility system tags after a content-changing write. */
export function tagsAfterWrite(tags: string[]): string[] {
  return withoutVolatility(withoutStaleAsOf(tags));
}

export function formatAsOfQualifier(updatedAt: number): string {
  const date = new Date(updatedAt).toLocaleDateString();
  return `true as of ${date}, verify before asserting`;
}
