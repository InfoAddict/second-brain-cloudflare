# Sealed hidden recall validation report

Production was frozen before materialization. The hidden fixture and benchmark were
committed before the observational metrics audit and were not changed afterward.

## Identity and seal

- Frozen production commit: `2e4965663b06eb25c809f05e6e4e56a54133d0f4`
- Hidden fixture/test commit: `e6a87584600795ef31553030be0c4bbf93163c6b`
- Compile-only tuple fix commit: `c808f48c524f867199262cfc05baafb8bab20917`
- Audited pre-fix fixture blob: `2578620ae2768fd9cdf1e6efbb4ff7dc7cb3a030`
- Final fixture blob: `a8a5f75b4f2edc9ff65c0a3d4667970e1f67540e`
- Audited benchmark blob: `5b6502e8a3f6987e90024c794ed6df374d5707aa`
- Final regression-enabled benchmark blob: `64aacc98c2f093ebaee8cde53ee14f1377ca58e4`
- Manifest SHA-256: `319c2553d379d2bf215f97ae89018e01658de15f8ddaceb21feda38f67ee9462`
- Serialization: UTF-8 bytes of `JSON.stringify(manifest)`, insertion-order v1,
  with no trailing newline.
- Reconstructed digest before materialization: exact match.
- Production diff from the frozen commit under `src/`: empty before and after
  the observational audit.
- Fixture/test blob hashes: identical before and after the observational audit.

After the audit, typecheck found that the topology row was expressed as a
numeric-key interface rather than an iterable tuple. Commit `c808f48` changed
only that erased TypeScript declaration to a readonly five-tuple. Esbuild emitted
byte-identical JavaScript before and after the fix, SHA-256
`57d583a52cfc47f9ff971bd13aea811523ccb3299dfe1e3e026d4d5217494dfe`.
The generated `HIDDEN_VALIDATION_CASES` JSON was also byte-identical, SHA-256
`540c9e08d4e55b8cb49dfe229e2227b4b1032e1a6fd16f4b1f6fe81e6d9c3456`.
The manifest digest remained
`319c2553d379d2bf215f97ae89018e01658de15f8ddaceb21feda38f67ee9462`.
No decision rerun followed the type-only correction.

## Frozen balance

- Cases: 10.
- Candidate-available: 8.
- Deliberate absent-cluster controls: 2.
- Domains: personal 3, enterprise 3, product 2, architecture 2.
- Failure shapes: two each of crowded lexical root, popular broad summary,
  long-parent pollution, weak generic neighbor, and absent-cluster control.
- All oracle IDs are literal, cases and nested values are recursively frozen, and
  every hidden geometry differs from every existing same-shape development or
  holdout case in at least five declared dimensions.

## Pre-decision structure validation

Command:

```bash
npx vitest run test/integration/recall-root-quality-hidden-validation.test.ts -t "hidden recall validation structure"
```

Result: exit 0; 3 passed and the gated decision test skipped.

One sealed conceptual label differs from the runtime classifier: the architecture
crowded-lexical query is declared chronological but the runtime profile is direct.
The case was retained unchanged. Runtime-intent equality is not an approved ship
gate, so the mismatch is reported diagnostically rather than used to alter or
exclude the case.

## First and sole release-decision run

Command:

```bash
HIDDEN_VALIDATION_DECISION=1 npx vitest run test/integration/recall-root-quality-hidden-validation.test.ts
```

Result: exit 0; 1 file passed, 4/4 tests passed. This is the sole release decision.
The repository's console interception suppressed the passing JSON payload, so this
run proved every encoded gate but did not preserve the exact metric values in its
captured output. No case, oracle, score, topology, production file, or gate changed.

## Observational reporting audit

The controller authorized one explicitly non-decision rerun solely to recover the
suppressed payload. Before and after the rerun, production SHA, the empty production
diff, and both fixture/test blob SHAs matched the values above.

Command:

```bash
HIDDEN_VALIDATION_DECISION=1 npx vitest run test/integration/recall-root-quality-hidden-validation.test.ts --disableConsoleIntercept --reporter=verbose
```

Result: exit 0; 1 file passed, 4/4 tests passed.

## Exact hidden metrics

| Metric | Hidden result |
| --- | ---: |
| Cases | 10 |
| Candidate availability | 8/10 |
| Fusion survival | 8/8 available roots |
| Seed recall | 8/8 available |
| Neighborhood reach | 6 |
| Authoritative answer@5 | 5/10 |
| Frozen pre-plan authoritative answer@5 | 2/10 |
| Improvement | +3/10 (+30 percentage points) |
| Useful selected-graph precision | 100% |
| Direct top-four regressions | 0 |
| Additional AI/embed calls | 0 |
| Additional Vectorize queries | 0 |

Absolute authoritative answer@5 is reported without an added threshold, as required.

## By domain

| Domain | Cases | Available | Fused | Seeds | Reach | Current authoritative | Baseline authoritative | Improvement | Graph precision | Direct regressions | Extra AI | Extra Vectorize |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Personal | 3 | 2 | 2 | 2 | 2 | 1 | 1 | 0 | 100% | 0 | 0 | 0 |
| Enterprise | 3 | 2 | 2 | 2 | 1 | 1 | 1 | 0 | 100% | 0 | 0 | 0 |
| Product | 2 | 2 | 2 | 2 | 1 | 1 | 0 | +1 | 100% | 0 | 0 | 0 |
| Architecture | 2 | 2 | 2 | 2 | 2 | 2 | 0 | +2 | 100% | 0 | 0 | 0 |

Every domain is non-regressive against its faithful frozen pre-plan baseline.

## Exact funnel

- Runtime-intent mismatch:
  `architecture/crowded-lexical-root/what followed the sundial lease epoch rollover`
  (declared chronology, runtime direct).
- Candidate-generation misses:
  `personal/absent-cluster-control/what happened after the copper cabin key handoff`;
  `enterprise/absent-cluster-control/why did the sable vendor attestation window move`.
- Fusion misses among available cases: none.
- Seed misses among available cases: none.
- Neighborhood-reach misses among available cases:
  `enterprise/weak-generic-neighbor/verdant council release readiness evidence docket notes`;
  `product/weak-generic-neighbor/canter beta rollout review evidence register summary trace`.
  These are deliberate abstention shapes whose authoritative evidence is direct.
- Authoritative answer misses:
  `personal/crowded-lexical-root/why was the kestrel rehearsal pickup reassigned`;
  the two weak-neighbor cases above; and the two absent-cluster controls above.
  The personal crowded case reached its authoritative node but rejected it for
  `no-evidence-gain`. Both weak-neighbor cases selected no related evidence.

## Gate result

All approved proportional gates passed:

- seed recall 8/8, required at least 7/8;
- useful graph precision 100%, required at least 70%;
- improvement +3/10, required at least +2/10;
- direct top-four regressions 0;
- additional AI/embed calls 0;
- additional Vectorize queries 0;
- no per-domain authoritative-answer regression.

No new absolute authoritative-answer threshold was introduced.

## Final verification

- `npm run typecheck`: exit 0; Wrangler type generation and `tsc --noEmit` passed.
- `npm test -- --reporter=dot`: exit 0; 151/151 files passed,
  1,855 tests passed, and the gated decision test was the sole skip.
- The decision environment variable was absent during the full suite, so the sealed
  decision set did not execute again.

## Ongoing regression status

After the sole decision and observational audit were frozen, the aggregate ship
assertions were enabled for normal test runs. Future executions use the same sealed
manifest, cases, faithful baseline, and gates as regression verification; they are
not new holdout decisions and do not authorize tuning. The runner-only change
removes the environment skip and renames the test as a regression. It does not
alter any case, oracle, score, topology, production code, baseline, metric, or gate.

Final verification after enabling the permanent regression: `npm run typecheck`
exited 0, and `npm test -- --reporter=dot` passed 151/151 files and all
1,856/1,856 tests with no skips. The hidden aggregate ran as regression
verification and reproduced its passing assertions.
