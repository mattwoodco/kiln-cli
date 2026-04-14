# Kiln Execution — Issues Log

Track all issues. Format:

```
## Issue N — <title>
- Status: open | fixed | deferred
- Phase:
- Root cause:
- Fix:
- Resolution:
```

---

## Issue 1 — turbo 2.9 requires `packageManager` field in root package.json
- Status: fixed
- Phase: 1
- Root cause: turbo 2.9.6 refuses to resolve workspaces without an explicit `packageManager` field.
- Fix: Added `"packageManager": "bun@1.3.1"` to root `package.json`.
- Resolution: `bunx turbo build/typecheck/lint` all pass.

## Issue 2 — biome formatter flagged two long-line cases after initial write
- Status: fixed
- Phase: 1
- Root cause: hand-written files wrapped a console.log and a z.enum that would fit on a single line at the 100-col width.
- Fix: Ran `bunx biome check --write apps packages` once to normalize.
- Resolution: `bunx turbo lint` now green (4/4).

## Issue 3 — Bun 1.3 lockfile name changed from `bun.lockb` to `bun.lock`
- Status: fixed
- Phase: 1
- Root cause: Bun 1.3 switched to a plain-text lockfile at `bun.lock`. Plan and task spec both referenced `bun.lockb`.
- Fix: Treat `bun.lock` as the canonical lockfile; `.gitignore` already does not exclude either name.
- Resolution: Install produces `bun.lock`. Noted in PROGRESS.md.

## Issue 4 — oclif `run()` needs package-root arg when invoked via bin/run.js from dist
- Status: fixed
- Phase: 2
- Root cause: `bin/run.js` called `run()` with no args, so oclif tried to discover the nearest `package.json` from the node entry — which resolved to `@oclif/core`'s own package, printing "base library for oclif CLIs" help instead of the CLI's commands.
- Fix: Pass `process.argv.slice(2)` and an explicit package root (`dirname(fileURLToPath(import.meta.url)) + "/.."`) into `run()`. Also updated `oclif.commands` in `apps/cli/package.json` from `./src/commands` to `./dist/commands` so the built bin resolves compiled command files.
- Resolution: `bun run apps/cli/bin/run.js --help` now lists all kiln commands. `scaffold --week 1 --no-docker --no-proxy --ci` produces a fully-populated week-01/ directory.

## Issue 5 — Phase 2 brownfield Dockerfile-presence check fired after template write
- Status: fixed
- Phase: 2
- Root cause: `hasExistingDockerfile()` was called after `generate()` ran. Because `docker-compose.yml` is written in brownfield mode when it's missing (skip-if-exists with no preexisting file), the presence check always found compose and suppressed the warning.
- Fix: Capture the pre-scaffold state into `preExistingDockerfile` before `generate()` runs, and emit the warning based on that snapshot.
- Resolution: Brownfield scaffold test now observes the "No Dockerfile or docker-compose.yml found" warning even when the scaffold wrote a compose.yml on its own.

## Issue 7 — Host Postgres shadows docker-bound :5432 on localhost
- Status: worked-around
- Phase: 5
- Root cause: macOS has a user postgres process listening on `localhost:5432` (IPv4 + IPv6). OrbStack's port forward for the `infra-postgres-1` container binds `*:5432` IPv4 but does NOT override localhost, so `postgres://kiln:kiln@localhost:5432/kiln` resolves to the host pg which has no `kiln` role.
- Fix: Use the container's bridge IP directly (`192.168.147.2` on this host) or stop the host pg.
- Resolution: drizzle-kit push + API tests + storeResults all work against `postgres://kiln:kiln@192.168.147.2:5432/kiln`. For CI / Fly, no host pg exists so the default `localhost:5432` will work.

## Issue 8 — drizzle-kit push needs `--force` when postgres user differs across DBs
- Status: fixed
- Phase: 5
- Root cause: drizzle-kit's "Pulling schema" step does a role check that fails fast if the database role that defaulted at install time doesn't exist (it printed `role "kiln" does not exist` against the host pg before we switched to the container IP).
- Fix: Pass explicit `DATABASE_URL` pointing at container IP; `--force` skips interactive prompts.
- Resolution: Schema push completes cleanly; `\dt` shows 13 tables.

## Issue 9 — Temporal worker bundler needs src/workflows/index.ts
- Status: fixed
- Phase: 5
- Root cause: `@temporalio/worker` webpack-based bundler resolves the `workflowsPath` directory as a module and requires an `index.(ts|js)`. Without it the grading-workflow test died with `Module not found`.
- Fix: Added `apps/grading/src/workflows/index.ts` re-exporting `gradeSubmission`.
- Resolution: TestWorkflowEnvironment runs the workflow end-to-end through mocked activities; step order + parallelism + cohort isolation assertions all pass.

## Issue 10 — Vitest 4 removed `test.poolOptions`; use top-level `pool`
- Status: fixed
- Phase: 5
- Root cause: Initial `vitest.config.ts` nested poolOptions under test — Vitest 4 prints a deprecation and prefers `fileParallelism: false` + `pool: "forks"`.
- Fix: Moved to the new shape.
- Resolution: No warnings; tests serialize across files as required by the shared test postgres.

## Issue 6 — @kiln/cli Phase 2: live Anthropic + Kiln API paths deferred
- Status: deferred
- Phase: 2
- Reason: `ANTHROPIC_API_KEY` is not available in test env; Kiln API (Phase 5) does not exist yet.
- What's missing: (1) real Haiku round-trip latency measurement in `kiln init`; (2) `POST /api/auth/login`, `GET /api/me`, `GET /api/cohorts/:id/weeks/:n` responses.
- How to re-validate later:
  - Anthropic: `export ANTHROPIC_API_KEY=sk-ant-...` then `bun run apps/cli/bin/run.js init --ci` — expect "Anthropic OK (<N>ms)".
  - Kiln API: once Phase 5 API is up, start it (`bunx turbo dev --filter=@kiln/api`) and rerun `kiln init --ci` — expect cohort info from `/api/me` instead of the "using mock cohort" warning, and `kiln scaffold --week 1 --ci` should fetch a real week config instead of the local fallback.
- Tests currently mock both layers (`vi.mock('@anthropic-ai/sdk')`, `vi.mock('../../src/lib/kiln-api.js')`).


## Issue 11 — Phase 4 real-tool validations DEFERRED
- Status: deferred
- Phase: 4
- Reason: Tests mock `Bun.spawn` (pumba) and `fetch` (toxiproxy). The `kiln audit` test suite `vi.mock`s `checkDockerBuild` + `checkRuntimeToolchainParity` so no real Docker/toolchain is required. The `--full` docker-up health check is intentionally a `skip` outcome — the proxy/start wait logic needs to be lifted into a shared helper before we can reuse it in audit.
- What's missing:
  1. Live Pumba round-trip against a real container.
  2. Live Toxiproxy REST round-trip.
  3. Real `docker compose build` through `kiln audit`.
  4. Docker-image-layer secret scan (currently we only scan the build context).
  5. The `--full` `docker compose up -d` + `curl /healthz` + `docker compose down` sequence.
- How to re-validate later:
  - Pumba: `brew install pumba`, start a throwaway container, run `kiln chaos kill --target <name>`.
  - Toxiproxy: `docker run -d -p 8474:8474 -p 5500-5511:5500-5511 shopify/toxiproxy`, create a proxy via the REST API, run `kiln chaos latency --target api --delay 500 --duration 3`.
  - `docker compose build`: from a scaffolded week project root, run `kiln audit --verbose` — expect `docker-build: succeeded in Ns`.
  - Layer scan: drop a `sk-ant-XXXXXXXXXXXXXXXXXXXXX` string into a file under the build context, run `kiln audit --full` — expect `secret-scan: 1 secret(s) detected`.
  - `--full` health: reuse the soon-to-be-extracted `waitForHealth` helper from `commands/proxy/start.ts` inside `audit.ts`, then run `kiln audit --full` from a project with compose up.

## Issue 12 — Phase 6 checkpoint DEFERREDs
- Status: deferred
- Phase: 6
- Reasons & re-validation plan:
  1. **Real Anthropic Sonnet calls for checkpoint**: stays behind `MOCK_LLM=1`. Validate live with `export ANTHROPIC_API_KEY=sk-ant-...; unset MOCK_LLM; bunx turbo test --filter=@kiln/grading` and watch for a single `checkpoint-analysis` call per run (not three). Compare cost in `pipeline_usage_events.total_estimated_cost_usd` with a full grading run for the same week — checkpoint should be substantially lower.
  2. **Real `sonar-scanner` CLI**: `analyze-code-light` reuses the REST fallback (`lib/sonar-scan.ts`). To validate the real scanner: install `sonar-scanner` on the runner host, point it at a workspace that's been analyzed as `checkpoint-<submissionId>`, run `bun run apps/cli/bin/run.js checkpoint`, and verify the SonarQube project is deleted on exit (`curl -u TOKEN: http://localhost:9000/api/projects/search?q=checkpoint-` returns empty).
  3. **Temporal Schedule for cleanup**: only `runCheckpointCleanup()` shipped. To validate a real schedule, once Phase 7.5 lands: `temporal schedule create --schedule-id checkpoint-cleanup --workflow-type runCheckpointCleanup --cron '0 3 * * *' --task-queue grading`, then `temporal schedule trigger --schedule-id checkpoint-cleanup` and diff `checkpoints` table before/after.
  4. **Full soft-audit depth**: the Chaos+Audit engineer shipped a richer `soft-audit.ts` (docker-presence, runtime parity, secret scan) before my work landed. I wired `kiln checkpoint` to consume the existing API (`SoftAuditResult.hardFailures[].name` / `.fix`) — no local stub needed. Validate by running `kiln checkpoint` from a project with a missing Dockerfile — expect a warning (criterion=ships, status=blocked) that does NOT block the run, and `evaluation_coverage.docker_build === "missing"` in the report.
  5. **Dispatch on `--persist`**: Phase 7.5 will wire dispatches. Dispatches fire only on `submissions.type="final"`; checkpoints never dispatch. Verify once 7.5 lands by running `kiln checkpoint --persist` and confirming zero `dispatch_events` rows for the submission.
  6. **CLI integration test for `kiln checkpoint`**: blocked on having a Temporal + API + mocked git remote test environment. Defer to Phase 8 hardening. Until then, the unit tests cover the downstream pieces (workflow, store, API, cleanup, scoping) and the command layer is thin glue.

## Issue 13 — Phase 7 usage-metrics DEFERREDs
- Status: deferred
- Phase: 7
- Reasons & re-validation plan:
  1. **Daily-rollup Temporal Schedule**: Phase 7 only ships the invokable `runDailyRollup(date?)` function. To validate a real Temporal Schedule once Phase 8 lands: `temporal schedule create --schedule-id usage-rollup --workflow-type runDailyRollup --cron '0 4 * * *' --task-queue api`, then `temporal schedule trigger --schedule-id usage-rollup` and verify a new row in `usage_daily_rollups` for yesterday's date.
  2. **Anthropic dashboard reconciliation (<10% drift)**: manual verification only. Run a full grading pipeline with `unset MOCK_LLM; export ANTHROPIC_API_KEY=sk-ant-...`, wait 24h for Anthropic billing to settle, then run `kiln admin usage --from <yesterday> --to <yesterday>` and compare `totalSpend` against the dashboard. Drift >10% means `pricing.ts` needs an update (and `PRICING_LAST_UPDATED` needs to be bumped in BOTH `apps/grading/src/lib/pricing.ts` AND `apps/api/src/routes/admin/usage.ts`).
  3. **Real super-admin distinction**: every admin JWT is currently treated as super-admin (see `requireSuperAdmin` in `apps/api/src/routes/admin/usage.ts`). To tighten: add an `isSuperAdmin: boolean` claim to `KilnJwtPayload`, change `requireSuperAdmin` to gate on `scope.isSuperAdmin === true`, and add an admin route to mint super-admin tokens. Single choke point.
  4. **Alert notifications**: alerts only land in the DB. Phase 8 should add a Slack/email notifier worker that polls `usage_alerts` where `acknowledged_at IS NULL` and dispatches with backoff. Validate by inserting an alert row manually and watching the worker pick it up.
  5. **`--verbose` per-call detail in `kiln admin usage`**: the flag is parsed but no extra rows are emitted yet. Easy follow-up — extend the routes to optionally embed `llm_calls` array in the cohort/week response, and have the CLI print one row per call when `--verbose` is set.

## Issue 14 — Phase 7.5 redact-payload regex regression
- Status: closed (test was incorrect — see Phase 7.5 notes in PROGRESS.md)
- Phase: 7.5
- Resolution: real `sk-ant-…` keys legitimately contain hyphens, so the regex `/sk-ant-[A-Za-z0-9_-]{20,}/g` is correct. The Phase 7 engineer's test fixture incorrectly assumed a hyphen would terminate the match. Updated the test to assert the correct behavior in `apps/grading/test/redact-payload.test.ts`.

## Issue 15 — Phase 7.5 secret in Temporal workflow history
- Status: open (deferred to Phase 8+)
- Phase: 7.5
- Symptom: the resolved secret is passed as an in-memory argument from `dispatch-single-target` workflow → `httpPostWithAuth` activity. Temporal stores activity input in workflow history, so the secret is at-rest in the Temporal Postgres `temporal-db` container.
- Why deferred: single-tenant on-prem deployment with encrypted volumes is acceptable for MVP. Real fix is a `DataConverter` that encrypts payloads with a KMS-managed key before they hit Temporal.
- Fix sketch: see `@temporalio/common` `DataConverter` interface. Wrap the JSON payload converter with a streaming AES-GCM encrypter keyed off `KILN_KMS_KEY`. Validate by manually inspecting `temporal_visibility` and confirming the activity input column for `httpPostWithAuth` is opaque cipher-text.

## Issue 16 — Phase 7.5 raw_archive size cap is a stub
- Status: open (deferred)
- Phase: 7.5
- Symptom: `build-payload.ts` returns `https://kiln.local/artifacts/<sub>/raw` as the signed-URL stub when the assembled payload exceeds 2 MB. The URL is not reachable. The non-capped path also returns a JSON listing rather than a real tar+base64.
- Why deferred: real signed-URL infra (S3 / Tigris / R2 / GCS) is not in MVP scope. The cap logic itself is correct — `payloadBytes` is recomputed after substitution and the test exercises the path.
- Fix sketch: install `@aws-sdk/s3-request-presigner`, sign a 5-minute presigned URL for the artifact directory, swap the stub URL. For the inline path: use `tar-stream` to pack the submission dir, base64-encode, attach. Validate via `curl -I "$signed_url"` returning 200 and via decoding the inline base64 in a follow-up test.

## Issue 17 — Phase 7.5 Portal endpoint is mock-only
- Status: open (deferred)
- Phase: 7.5
- Symptom: no real Kiln Portal endpoint is wired. `seedPortalTarget` creates a row pointed at whatever URL the admin passes in, with `enabled: false` by default. The `dispatch-single-target.test.ts` suite uses a scripted `httpPostWithAuth` rather than a real HTTP server.
- Why deferred: the Portal API surface is not yet finalised — the spec only commits to "POST a JSON payload, return `{job_id|interview_id, ...}`". The shaper handles both response shapes.
- Re-validation when Portal lands: stand up a `Bun.serve` mock on `http://localhost:7777`, call `seedPortalTarget` with that URL, set `PORTAL_TOKEN_COHORT_<id>=test-token`, flip the row to `enabled: true`, run a final-stage grading pipeline, and assert the dispatch_events row carries the mock's response ref. Then kill the mock mid-retry and assert the final row is `dead_letter`.

## Issue 18 — Phase 8 regression suite MOCK_LLM drift is deterministic, not graded
- Status: deferred (by design)
- Phase: 8
- Symptom: `apps/grading/test/regression/regression.test.ts` runs with `MOCK_LLM=1` which produces a fixed score vector (20/20/15/12/13) that doesn't vary per submission. The ±5 drift check is therefore guarded behind `process.env.REAL_LLM === "1"` and skipped in CI.
- Why deferred: real drift validation requires a live `ANTHROPIC_API_KEY` and is a T1 pre-flight exercise, not a CI gate. The regression suite's job in CI is to catch prompt/schema drift via shape checks (5 rubric scores, citations on talking points, tool in ai_usage, rubric-version hash) — which it does.
- Re-validation: `export ANTHROPIC_API_KEY=sk-ant-...; export REAL_LLM=1; unset MOCK_LLM; cd apps/grading && bunx vitest --project regression run`. Any submission whose score drifts beyond ±5 points to either a prompt regression or stale expected_scores in `manifest.json`.

## Issue 19 — Phase 8 CLI integration tests for submit/checkpoint/audit still deferred
- Status: deferred
- Phase: 8
- Symptom: the hardening pass for `kiln submit` (3x push retry, remote verify), `kiln checkpoint` (fetch retry, partial-evidence, timeout messaging), and `kiln audit` (secret-scan detail, --fix chaos-config) is covered by unit-level mocks and manual runs but has no dedicated end-to-end test suite with a real Temporal + API + mocked git remote topology.
- Why deferred: Issue 12 already tracked this for checkpoint specifically. Phase 8 widens it to cover submit + audit too. The MVP bar is met by unit coverage.
- Re-validation: stand up `@kiln/api` + `@kiln/grading` worker + a local GitLab mock (e.g. `nock`) and run each command from a fixture repo. Assert KilnError codes + fix strings on the error paths.

## Issue 20 — Live-LLM grading pipeline silently falls back to mock on JSON parse failure
- Status: open (surfaced by live validation)
- Phase: 5 / 8
- Symptom: `apps/grading/src/activities/generate-one-sheet.ts:141-148` parses the Opus pass3 synthesis output; if the text doesn't parse as JSON, the code catches the error and substitutes `buildMockOneSheet(input)`. A live run (`apps/grading/scripts/live-smoke.ts gs-be-mid` on 2026-04-14) with real ANTHROPIC_API_KEY produced 3 real API calls (2× Sonnet + 1× Opus, 87s wall, $0.33 cost) but the final `grading_results.oneSheet` carried the literal mock rationale strings (`"Mock rationale: build + tests report OK."` etc). This means the pass3 prompt isn't strong enough to reliably produce a JSON-only response, AND the fallback path masks the failure mode.
- Root cause (two-part):
  1. `pass3-synthesis.txt` does not explicitly instruct Opus to return ONLY a JSON object matching `OneSheetSchema` — the prompt is currently prose-heavy. Opus responds with prose + embedded JSON, which fails `JSON.parse` on the whole response.
  2. The catch branch silently substitutes the mock with no warning log, no flag on `LLMCallDetail`, and no surfacing in the one-sheet itself. Downstream consumers see what looks like a real grading result.
- Fix (post-MVP):
  1. Tighten `pass3-synthesis.txt` with: explicit "Return ONLY a JSON object conforming to this schema" header, a trimmed schema snippet, and an example block tagged "BEGIN EXAMPLE — DO NOT COPY THIS TEXT INTO YOUR OUTPUT". Consider switching to `tool_use` with a strict input_schema instead of plain text.
  2. Wrap the parse in a helper that extracts the first `{...}` block via balanced-brace walk before falling back to `JSON.parse`, since Anthropic often wraps JSON in markdown fences.
  3. Change the catch branch to `log.error` + emit a `ParseFailure` flag on the grading_result row rather than silently inserting the mock shape. The pipeline should still store SOMETHING so the student isn't blocked, but it must be clearly marked as degraded.
  4. Add a regression test that feeds a fixture "Opus response with prose around JSON" into the parser and asserts the real fields survive, not mock fields.
- Resolution: not fixed in this MVP pass — the live validation surfaced the issue, but the MOCK_LLM CI path is unaffected and the 219-test baseline is still green. Tracked for T1 pre-flight prompt tuning.
