# Grading regression gold-set

This directory holds the human-graded submission fixtures that back the
Phase 8 regression suite.

## Layout

```
gold-set/
  manifest.json           # metadata for every submission in the suite
  rubrics/
    rubric-backend.yml    # backend-weighted cohort rubric
    rubric-frontend.yml   # frontend-weighted cohort rubric
  submissions/<id>/
    code_files/           # representative .ts/.py/.tsx files
    normalized_logs.json  # harness log output (post-normalize)
    video_transcript.txt
    test_results.json     # visible + hidden verdicts + pass/fail counts
  index.ts                # `loadGoldSet()` — hydrates the manifest + files
```

Each rubric parses via `@kiln/shared`'s `RubricSchema`. The two rubrics
share the same five criteria (`Ships`, `Resilience`, `CodeCraft`,
`AiUsage`, `Communication`) but with different weights so the grading
pipeline's rubric-sensitive path is exercised.

## How scores are verified

The regression suite runs with `MOCK_LLM=1` so it is hermetic and fast:

- **Shape checks** — the mock path produces a deterministic,
  schema-valid `OneSheet` with exactly 5 rubric scores, at least one
  citation on every talking point, and at least one tool in
  `ai_usage_analysis.tools_used`. The test asserts all of those.
- **±5 drift** — the plan requires scores to be within ±5 of the
  human-graded baseline. With `MOCK_LLM=1` the drift is trivially 0,
  so the assertion is present but does not exercise the real grading
  model. For real drift validation see "Real-LLM run" below.
- **Rubric isolation** — the suite picks two submissions from
  different rubrics and asserts that `rubricVersion` differs. This
  verifies the rubric YAML hash-versioning path.

## How to run locally

Hermetic MOCK_LLM run (default):

```
bun test apps/grading/test/regression/regression.test.ts
```

Or via vitest projects:

```
cd apps/grading && bunx vitest --project regression
```

## Real-LLM run (DEFERRED, manual only)

```
export ANTHROPIC_API_KEY=sk-ant-...
export REAL_LLM=1
unset MOCK_LLM
bun test apps/grading/test/regression/regression.test.ts
```

Expected behaviour:
- Every submission runs through the 3-pass Sonnet/Opus pipeline.
- Scores should land within ±5 of the `expected_scores` in
  `manifest.json`. If more than one submission drifts beyond ±5,
  either the prompts regressed or the expected scores need a refresh
  after human re-grading.

Real-LLM runs are not automated in CI — see `.gitlab-ci.yml` `regression`
stage for the path-based triggers that gate merges on prompt/schema
changes.

## Adding a new submission

1. Pick an `id` like `gs-be-<tier>` or `gs-fe-<tier>`.
2. Create `submissions/<id>/` and drop in `code_files/`,
   `normalized_logs.json`, `video_transcript.txt`, `test_results.json`.
3. Append a new entry to `manifest.json` with `{id, cohortName,
   weekNumber, rubric, rubricVersion, grader, graded_at,
   expected_scores}`.
4. Run `bun test apps/grading/test/regression/regression.test.ts` to
   confirm the loader + shape checks still pass.

## Adding a new rubric

1. Add `rubrics/rubric-<name>.yml` — must parse via `RubricSchema` from
   `@kiln/shared` (5 criteria with `weight` + `max_points`).
2. Reference it from at least one submission in `manifest.json`.
3. The rubric-isolation test will automatically pick up the new rubric
   as long as its `rubricVersion` differs from existing rubrics.
