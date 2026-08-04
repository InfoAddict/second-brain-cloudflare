export const VOLATILITY_VALUES = ["durable", "state", "volatile"] as const;
export type Volatility = (typeof VOLATILITY_VALUES)[number];
export const VOLATILITY_PREFIX = "volatility:";

export function getVolatility(tags: string[]): Volatility | null {
  const tag = tags.find(t => t.startsWith(VOLATILITY_PREFIX));
  if (!tag) return null;
  const value = tag.slice(VOLATILITY_PREFIX.length) as Volatility;
  return (VOLATILITY_VALUES as readonly string[]).includes(value) ? value : null;
}

export function withVolatility(tags: string[], volatility: Volatility): string[] {
  const cleaned = tags.filter(t => !t.startsWith(VOLATILITY_PREFIX));
  return [...cleaned, `${VOLATILITY_PREFIX}${volatility}`];
}

export function withoutVolatility(tags: string[]): string[] {
  return tags.filter(t => !t.startsWith(VOLATILITY_PREFIX));
}
