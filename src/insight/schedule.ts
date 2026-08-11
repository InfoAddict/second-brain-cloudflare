/**
 * The two insight schedules, in one place.
 *
 * They are separate from the maintenance cron because they are separate
 * budgets, the same argument wrangler.jsonc already makes for the integration
 * sync (#290): a Worker invocation gets 50 D1 subrequests and 10 ms of CPU on
 * the free plan, maintenance already spends about 30 of them, and accrual needs
 * about 34 on its own (see src/insight/candidates.ts's ACCRUAL_SEED_LIMIT
 * comment for the measurement).
 *
 * These strings must match wrangler.jsonc exactly. test/unit/cron-triggers.test.ts
 * fails if they drift.
 */

/** Nightly. Offset from maintenance at :00 so the two never share a minute. */
export const INSIGHT_ACCRUAL_CRON = "45 1 * * *";

/** Sundays, after the night's accrual has landed. */
export const INSIGHT_WEEKLY_CRON = "15 2 * * 0";
