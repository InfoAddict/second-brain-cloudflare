import { escapeLikeMeta } from "../constants";

/** Literal substring pattern for content LIKE clauses. */
export function contentLikePattern(token: string): string {
  return `%${escapeLikeMeta(token)}%`;
}

export { LIKE_ESCAPE as CONTENT_LIKE_ESCAPE } from "../constants";
