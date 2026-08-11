// The insight review queue, in one predicate.
//
// The weekly insight pass proposes observations it drew from two memories, and
// they are excluded from recall until a human confirms them. Dismissing one
// deprecates it rather than deleting it — the audit row stays, tags and all —
// so an entry carries `insight` forever whether or not it was ever ruled on.
// The tag alone is a history, not a queue.
//
// Reading it as a queue is what broke the dashboard's panel under the previous
// producer: it asked for the newest twenty rows and dropped the deprecated ones
// in the browser, so on a brain with more than a page of dismissals it threw
// away every row it fetched and rendered empty while real proposals waited
// behind them. Whoever asks "what still needs a decision?" needs both halves,
// which is why they live here together.

/** Proposed by the weekly insight pass, and not yet ruled on. */
export const PENDING_INSIGHT_SQL = `tags LIKE '%"insight"%' AND tags NOT LIKE '%"status:deprecated"%'`;
