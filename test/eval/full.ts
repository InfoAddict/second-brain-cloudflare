/**
 * The full eval replays the golden set (1,751 queries on core-1k) and takes minutes per test, so it is opt-in: the default
 * `vitest run`, `npm run test:coverage` and CI skip it. `npm run test:eval:full` sets EVAL_FULL=1 and runs it; run that by
 * hand before merging any ranking change. The fast end-to-end check of the harness that stays in the default suite is smoke.test.ts.
 */
export const EVAL_FULL = Boolean(process.env.EVAL_FULL);
