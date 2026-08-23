import type { VectorizeMatch } from "./math";
import { queryRelevantWindow } from "./snippet";

export function localEvidenceOf(
  match: VectorizeMatch,
  parentContent: string,
  queryTokens: string[],
): string {
  const metadataContent = (match.metadata as Record<string, unknown> | undefined)?.content;
  if (typeof metadataContent === "string" && metadataContent.trim()) {
    return queryRelevantWindow(metadataContent, queryTokens);
  }
  return queryRelevantWindow(parentContent, queryTokens);
}
