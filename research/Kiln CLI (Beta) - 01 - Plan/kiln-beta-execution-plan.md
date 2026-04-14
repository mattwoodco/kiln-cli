# Kiln — Claude Code Execution Plan

---

## 0. Metadata

| Field | Value |
|-------|-------|
| **Name** | `kiln-execution-plan` |
| **Description** | Step-by-step implementation plan for Kiln — a CLI-first developer education platform with AI capture proxy, chaos engineering, LLM-powered async grading pipeline, mid-project checkpoint system for formative feedback, and usage/cost metrics for admin visibility |
| **Inputs** | PRD (April 2026) |
| **Outputs** | TypeScript monorepo: CLI (oclif), kiln-proxy (Go), Fastify API server, Temporal grading + checkpoint workers, PostgreSQL schema, usage analytics, pluggable artifact dispatch subsystem (first target: Kiln Portal) |
| **Constraints** | TypeScript/Bun runtime + workspaces, oclif CLI framework, Turborepo, Vitest + Biome tooling, structured outputs via `zodOutputFormat()`, 1M context window (no chunking) |
| **Vendors (total: 3)** | Anthropic API, Fly.io (server + volume), GitLab (free tier or existing instance) |

---

## Design Decisions

### Core Architecture

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Package manager | **Bun workspaces** (not pnpm) | Already the runtime and compiler. Eliminates a tool. Native workspaces, faster installs, `bun.lockb` binary lockfile. |
| Object storage | **Fly Volume** (`/data/`) | No S3 SDK, no bucket config. Plain filesystem. Swap to R2 later if needed. |
| Container registry | **Build proxy from source** | Proxy is <500 LOC Go. Ship source in scaffold templates. No registry account. |
| Code analysis | **SonarQube Community Build + Claude Sonnet hybrid** | SonarQube for deterministic metrics (complexity, duplication, coverage). LLM for qualitative assessment (naming, architecture, idiomatic usage). Self-hosted, free, Docker-native. |
| Grading regression | **Vitest gold-set suite** (not PromptFoo) | Same assertions, native to test stack. PromptFoo acquired by OpenAI — questionable fit for Anthropic pipeline. |
| Source control / CI | **GitLab** | Repos + CI + built-in registry + webhooks in one platform. Groups map to cohorts. |
| Multi-tenancy | **Multi-cohort, 100 students/cohort** | Cohorts have independent projects, rubrics, templates. Students see only their cohort. Graders may span cohorts. |

### Checkpoint System

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Checkpoint trigger | **Student-initiated via CLI** (not automatic) | Students decide when they want feedback. Avoids surprise server load. Matches the CLI-first philosophy. |
| Pipeline variant | **Reduced workflow — skip strict audit, skip full one-sheet synthesis** | A checkpoint should return in <90s. The full 3-pass pipeline is overkill for formative feedback. |
| Output format | **Checkpoint report (not a one-sheet)** | Different Zod schema. Lighter, focused on actionable gaps rather than evaluative scoring. Clearly distinct from the graded artifact. |
| Scoring | **Indicative only — not recorded as a grade** | Checkpoint scores are directional. They use the same rubric but carry a `"checkpoint"` designation and do not count toward final results. |
| Storage | **Ephemeral by default, persisted on opt-in** | Checkpoints stored for 7 days, then cleaned up. `--persist` flag writes to Fly Volume alongside final submissions. Keeps disk usage bounded. |
| Rate limiting | **None** | Checkpoints are student-initiated and lightweight (<90s, single Sonnet call). Cost is managed through visibility — admin usage dashboards make spend transparent rather than capping access. |
| Build/test requirement | **Best-effort, not gating** | If Docker build fails, the checkpoint still runs code analysis and log analysis on whatever exists. The report notes what couldn't be evaluated. |

### Usage & Cost Metrics

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Cost tracking | **Per-pipeline usage events + daily rollups** | Atomic cost accounting at the pipeline level. Rollups keep dashboard queries fast as the events table grows. |
| Cost estimation | **Client-side token counting × published rates** | Directional, not reconciliation-grade. Good enough for planning. Actual billing comes from Anthropic dashboard. |
| Alert delivery | **API-only for MVP** (admin polls) | Keeps scope tight. Phase 3 dashboard or Slack notifications can layer on. |
| LLM call instrumentation | **Thin wrapper around Anthropic SDK** (`trackedLLMCall()`) | Records tokens, cache stats, latency, and cost per call. Accumulates on workflow context. Zero changes to LLM logic itself. |

### Artifact Dispatch

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Dispatch orchestration | **Child Temporal workflow from `store-results`** | Isolates retries/backoff from the grading workflow. A dispatch failure never blocks or fails grading. Resumable and observable in Temporal UI. |
| Target configuration | **Admin-managed `dispatch_targets` table, scoped by cohort (+ optional week)** | Same multi-tenancy model as rubrics. Admins register URL + auth + selectors + retry policy per cohort. No code deploy to add a new destination. |
| Trigger policy | **Final submissions only by default, admin-configurable per target** | Checkpoints are formative and must never leak downstream. Early submissions also skip dispatch by default (dress rehearsal only). Admins can opt a target into additional triggers if ever needed. |
| Artifact selection | **Named selectors** (`one_sheet`, `logs_summary`, `sonar_metrics`, `ai_usage`, `raw_archive`) | Targets declare which artifacts they need. Payload assembled once, cached, and reused across targets. |
| First concrete target | **Kiln Portal** — generic HTTPS POST with bearer auth that generates tailored interview questions and triggers a video interview workflow from a one-sheet + AI usage snapshot | Exercises every piece of the subsystem (auth, selectors, transform, retry, observability) without bespoke code. |
| Failure handling | **Exponential backoff (1s, 4s, 16s, 64s, 256s), max 5 attempts, dead-letter on give-up** | Retry policy is per-target JSON, with sane defaults. Dead-letter rows stay in `dispatch_events` with `status: "dead_letter"` for admin inspection. |
| Secrets | **`auth_secret_ref` points at env var / secret name, never stored inline** | Same pattern as GitLab token. Redacted from every log line and dispatch event payload snapshot. |
| Payload size cap | **2 MB per dispatch; larger artifacts replaced with signed URLs** | Keeps endpoints healthy; raw archives are never POSTed inline. |

---

## 1. Objective

Build Kiln as a Bun workspace + Turborepo monorepo containing:

1. An **oclif CLI** with `init`, `scaffold`, `proxy`, `chaos`, `audit`, `logs`, `submit`, `checkpoint`, `doctor`, `status`, `results`, `config`, and `admin usage` commands using Clack prompts and Bun-native scaffolding.
2. A **kiln-proxy** reverse-proxy sidecar (Go, built from source locally) that captures full LLM request/response payloads to JSONL with <5ms overhead.
3. A **Fastify API server** receiving submissions and checkpoints via GitLab webhook and CLI.
4. A **Temporal-orchestrated grading pipeline** executing clone → parallel(build+test ∥ log-normalization) → SonarQube + LLM code analysis → 3-pass LLM one-sheet generation → store-results to PostgreSQL + Fly Volume.
5. A **checkpoint pipeline** — a reduced Temporal workflow that produces formative, rubric-aware feedback in <90s using best-effort build/test, SonarQube metrics, and a single Sonnet pass. Output is a student-facing checkpoint report, not a graded one-sheet.
6. A **usage & cost metrics system** that tracks per-pipeline token consumption, cost estimates, cache efficiency, and infrastructure durations. Daily rollups, admin API routes, anomaly alerts, and a CLI drilldown give admins real-time visibility into spend.
7. A **multi-cohort data model** supporting multiple concurrent cohorts of up to 100 students, each with independent project templates, rubrics, and grading pipelines.
8. An **extensible artifact dispatch subsystem** that, after a successful final grading, dispatches configured artifacts (one-sheet, logs summary, SonarQube metrics, AI usage, raw archive) to admin-registered external endpoints via a child Temporal workflow with retries, dead-lettering, and per-attempt observability. The first concrete target is the Kiln **Portal**, which generates tailored technical interview questions and triggers a video interview workflow from a student's one-sheet + AI usage snapshot.
9. A **two-stage final submission model** (`early` Thursday 11:59 PM CT dress rehearsal, `final` Saturday 11:59 PM CT graded run) with **split chaos profiles** — visible set shipped to students, hidden set stored server-side and injected only on `stage: "final"` grading runs to discourage overfitting.
10. A **Vitest regression suite** with gold-set fixtures gating all prompt/model changes.

---

## 2. Success Criteria

### Monorepo & Tooling
- [ ] `bun install` at root resolves all workspace dependencies, produces `bun.lockb`
- [ ] `bunx turbo build` compiles all packages with zero errors
- [ ] `bunx turbo typecheck` — zero errors
- [ ] `bunx turbo lint` — zero Biome violations

### CLI
- [ ] `kiln init` validates Docker, Git, API keys with live test calls, installs shell completions, writes `~/.kiln/config.json` — completes in <60s
- [ ] `kiln scaffold --week 3` generates a project directory with `docker-compose.yml` (builds kiln-proxy from source + `develop.watch`), `.kiln/`, `.env`, `Makefile`, `spec.md`, `rubric.yml` — completes in <30s
- [ ] `kiln proxy start` starts capture sidecar; `:9100` (Anthropic), `:9101` (OpenAI), `:9102` (Google) forward upstream and log to `.kiln/harness.jsonl` with <5ms overhead
- [ ] `kiln chaos latency --target postgres --delay 500ms --duration 60s --verify` verifies steady-state pre/post, saves results with `verdict`
- [ ] `kiln audit` validates files, Docker build, proxy capture integrity — concise default, `--verbose` for detail
- [ ] `kiln submit --stage early|final` runs audit, pushes to GitLab, POSTs to `/api/submissions` with the chosen stage, returns job ID. Default stage is `final`. Early submissions run the full pipeline minus the hidden chaos set.
- [ ] `kiln checkpoint` runs soft audit, pushes to GitLab, POSTs to `/api/checkpoints`, returns checkpoint report in <90s
- [ ] `kiln admin usage` displays cost summary, per-cohort breakdown, alerts
- [ ] All CLI commands support `--ci` and `--verbose`

### Grading Pipeline
- [ ] SonarQube scanner produces deterministic metrics, Sonnet evaluates code quality using those metrics as evidence, Opus synthesizes one-sheet
- [ ] One-sheet JSON passes `OneSheetSchema` Zod validation with zero errors
- [ ] Pipeline processes one submission end-to-end in <3 min wall-clock
- [ ] `run-tests` activity loads BOTH the visible chaos profile (from student repo `.kiln/chaos-profiles/week-XX.yml`) AND the server-side hidden chaos profile (from `weeks.hidden_chaos_yaml`), runs both on `stage: "final"`, runs visible-only on `stage: "early"`, and captures labeled results for each set
- [ ] Early submissions (`stage: "early"`) produce a complete one-sheet EXCEPT hidden-chaos results are absent and the Resilience axis is marked `"dress_rehearsal"` rather than final
- [ ] Hidden chaos profile is never returned by any student-facing API endpoint — verified by integration test
- [ ] `build-docker` activity handles missing `Dockerfile` / `docker-compose.yml` and build failures as graded rubric outcomes (Ships = 0 with reason) rather than workflow crashes

### Checkpoint System
- [ ] Checkpoint completes in <90s wall-clock
- [ ] Checkpoint with incomplete project (no Docker, no tests) completes with partial `evaluation_coverage` — does not crash
- [ ] Checkpoint report validates against `CheckpointReportSchema`
- [ ] Checkpoint scores are NOT recorded in `grading_results` — separate `checkpoints` table only
- [ ] Expired checkpoints (>7 days) are cleaned up automatically
- [ ] `--persist` flag overrides TTL

### Usage & Cost Metrics
- [ ] Every pipeline run (grading + checkpoint) emits a `pipeline_usage_events` row with token counts, cost estimate, and durations
- [ ] Daily rollup aggregates events correctly
- [ ] Admin API returns cohort/student/week cost breakdowns
- [ ] Anomaly alerts fire at configured thresholds
- [ ] Cost estimate is within 10% of Anthropic dashboard (manual verification)

### Multi-Cohort
- [ ] Two cohorts with different projects/rubrics can run grading pipelines concurrently without interference
- [ ] API correctly scopes students to their cohort — no cross-cohort data leakage
- [ ] Checkpoints scoped by cohort — student in cohort A cannot see cohort B checkpoints

### Artifact Dispatch
- [ ] Successful final grading triggers a child `dispatch-artifacts` Temporal workflow; checkpoints and early submissions never do
- [ ] `dispatch_targets` CRUD via admin API — cohort-scoped, optionally week-scoped, enabled/disabled per target
- [ ] Each dispatch attempt writes a `dispatch_events` row with status, http_status, latency_ms, attempt, payload_bytes
- [ ] Failures retry with exponential backoff per target policy; max-attempts → `status: "dead_letter"`
- [ ] Dispatch failure never marks the grading result failed or blocks result visibility
- [ ] Portal target posts `{ one_sheet, ai_usage }` to the configured URL with `Authorization: Bearer <secret>` and records Portal response id
- [ ] Secrets resolved from env/secret store by `auth_secret_ref` — never stored inline, never logged
- [ ] Admin can list targets, list events, and re-dispatch a specific submission×target via admin API

### Regression
- [ ] Vitest regression suite passes on gold set and blocks merge on ±5 point drift
- [ ] Gold set spans ≥2 different cohort rubrics

---

## 3. System Scope

### INCLUDED (MVP — Phases 1–8)

- Monorepo: `packages/cli`, `packages/proxy`, `packages/api`, `packages/grading`, `packages/shared`
- Bun workspaces + Turborepo (no pnpm, no npm, no yarn)
- Full CLI: `init`, `scaffold` (with `--adopt`), `proxy`, `chaos`, `audit`, `logs`, `submit` (with `--stage early|final`), `checkpoint`, `doctor`, `status`, `results`, `config`, `admin usage`
- **Brownfield adoption:** `kiln scaffold --adopt` operates on existing repos — installs `.kiln/` proxy + config + rubric + spec alongside existing code without overwriting `Dockerfile` or `docker-compose.yml` if present
- **Tool & runtime discovery:** `init`, `doctor`, `audit`, and `scaffold` detect the project's declared runtimes (via `package.json`, `requirements.txt`/`pyproject.toml`, `go.mod`, `Cargo.toml`, `Gemfile`, etc.) and verify toolchain installation + minimum versions
- **Dockerfile/compose validation:** `kiln audit` hard-fails on missing or unbuildable `Dockerfile` / `docker-compose.yml`; `kiln checkpoint` soft-audit warns but does not block
- **Two-stage final submission model:** `early` (Thursday 11:59 PM CT dress rehearsal — full pipeline minus hidden chaos) and `final` (Saturday 11:59 PM CT — full pipeline including hidden chaos). `checkpoint` remains the mid-week formative tool.
- **Split chaos profiles:** visible set shipped in student repo as `.kiln/chaos-profiles/week-XX.yml` (runnable locally via `kiln chaos profile --week N`); hidden set stored server-side in `weeks.hidden_chaos_yaml`, injected into the grading pipeline only on `stage: "final"`. Both sets share fault categories and steady-state criteria; hidden set uses different target/timing/intensity permutations to discourage overfitting.
- kiln-proxy: Go source shipped in scaffold templates, built locally
- Fastify API: `/api/submissions`, `/api/checkpoints`, `/api/webhooks/gl`, `/api/results/:id`, `/api/cohorts`, `/api/admin`, `/api/admin/usage`, `/api/admin/dispatch`
- Temporal workflows: full 7-step grading pipeline + reduced 7-step checkpoint pipeline + child `dispatch-artifacts` workflow
- **Artifact dispatch subsystem:** pluggable targets (`dispatch_targets`), per-attempt observability (`dispatch_events`), named artifact selectors, Portal integration as first concrete target, admin CRUD and re-dispatch
- **Checkpoint system:** student-initiated formative feedback with best-effort build/test, single-pass Sonnet analysis, ephemeral storage with 7-day TTL
- **Usage & cost metrics:** per-pipeline usage events, daily rollups, admin API, anomaly alerts, CLI drilldown, CSV export
- **Multi-cohort data model:** cohorts → weeks (per-cohort) → projects (per-week templates, rubrics) → students (scoped to cohort) → submissions → grading results / checkpoints
- PostgreSQL + Drizzle schema with cohort-scoped queries
- **SonarQube Community Build** as Docker sidecar — deterministic code metrics
- **Claude Sonnet hybrid** — LLM evaluates code quality using SonarQube metrics + source as evidence
- Zod schemas for all data contracts
- Structured outputs via `zodOutputFormat()` for all LLM calls
- Prompt caching with shared prefix per cohort+week (shared between grading and checkpoint pipelines)
- Vitest regression suite with gold-set fixtures
- Fly Volume for artifact storage
- GitLab for source control, CI, webhooks
- Progressive disclosure + error messages with fix commands

### EXCLUDED

- Next.js dashboard (Phase 3 — future)
- Grader override web UI (Phase 3 — future)
- Fly Machines microVM isolation (use local Docker/gVisor for dev)
- Plagiarism/collusion detection (future)
- Video analysis beyond transcript (future)
- Adaptive rubrics (future)
- Langfuse integration (add when pipeline is stable)
- Auto-triggered checkpoints (future — requires webhook-based triggering)
- Checkpoint diffing (future — compare checkpoint-to-checkpoint or checkpoint-to-final)
- Grader-initiated checkpoints (future — privacy implications need thought)
- Budget caps with soft/hard enforcement (future — if visibility alone isn't sufficient)
- Anthropic API billing reconciliation (future — requires billing API access)
- S3/R2 object storage
- Container registry
- pnpm / npm / yarn

---

## 4. Execution Plan

### Phase 1 — Setup & Initialization

**Goal:** Scaffold the Bun monorepo, install tooling, establish project structure, dev infrastructure (including SonarQube), and CI.

**Steps:**

1. Create root `package.json`:
   ```json
   {
     "name": "kiln",
     "private": true,
     "workspaces": ["packages/*"],
     "scripts": {
       "build": "turbo build",
       "test": "turbo test",
       "lint": "turbo lint",
       "typecheck": "turbo typecheck"
     },
     "devDependencies": {
       "turbo": "^2",
       "typescript": "^5.7"
     }
   }
   ```
   No `pnpm-workspace.yaml`. Bun reads `workspaces` from `package.json` natively.
2. Create `turbo.json` with pipeline: `build` depends on `^build`, `test` depends on `build`, `lint` has no deps
3. Create root `tsconfig.base.json`: `strict: true`, `target: "ES2023"`, `module: "NodeNext"`, `moduleResolution: "NodeNext"`
4. Create `biome.json`: formatter (indent 2, double quotes), linter (recommended rules)
5. Create `docker-compose.infra.yml` — dev infrastructure:
   ```yaml
   services:
     temporal:
       image: temporalio/auto-setup:latest
       ports: ["7233:7233"]
       depends_on: [temporal-db]
       environment:
         - DB=postgresql
         - DB_PORT=5432
         - POSTGRES_USER=temporal
         - POSTGRES_PWD=temporal
         - POSTGRES_SEEDS=temporal-db
     temporal-db:
       image: postgres:16
       environment:
         POSTGRES_USER: temporal
         POSTGRES_PASSWORD: temporal
     temporal-ui:
       image: temporalio/ui:latest
       ports: ["8080:8080"]
       environment:
         - TEMPORAL_ADDRESS=temporal:7233
     postgres:
       image: postgres:16
       ports: ["5432:5432"]
       environment:
         POSTGRES_DB: kiln
         POSTGRES_USER: kiln
         POSTGRES_PASSWORD: kiln
       volumes:
         - pgdata:/var/lib/postgresql/data
     redis:
       image: redis:7
       ports: ["6379:6379"]
     sonarqube:
       image: sonarqube:community
       ports: ["9000:9000"]
       environment:
         - SONAR_ES_BOOTSTRAP_CHECKS_DISABLE=true
         - SONAR_JDBC_URL=jdbc:postgresql://sonar-db:5432/sonar
         - SONAR_JDBC_USERNAME=sonar
         - SONAR_JDBC_PASSWORD=sonar
       depends_on: [sonar-db]
       volumes:
         - sonardata:/opt/sonarqube/data
     sonar-db:
       image: postgres:16
       environment:
         POSTGRES_DB: sonar
         POSTGRES_USER: sonar
         POSTGRES_PASSWORD: sonar
       volumes:
         - sonardbdata:/var/lib/postgresql/data
   volumes:
     pgdata:
     sonardata:
     sonardbdata:
   ```
6. Initialize `packages/shared/`:
   - `package.json` with `"name": "@kiln/shared"`, no external deps except `zod`
   - `tsconfig.json` extending base
   - `src/schemas/one-sheet.ts` — `OneSheetSchema` (exact fields from PRD)
   - `src/schemas/harness-log.ts` — `HarnessLogEntrySchema`
   - `src/schemas/chaos-result.ts` — `ChaosResultSchema` (with `steady_state_pre/post`, `verdict`)
   - `src/schemas/audit-result.ts` — `AuditResultSchema`
   - `src/schemas/rubric.ts` — `RubricSchema` (criteria, weights, sub-scores)
   - `src/schemas/cohort.ts` — `CohortSchema`, `WeekConfigSchema`, `ProjectTemplateSchema`
   - `src/schemas/sonar-metrics.ts` — `SonarMetricsSchema` (complexity, duplication, code_smells, coverage, maintainability_rating)
   - `src/schemas/checkpoint.ts` — `CheckpointReportSchema`, `CheckpointGapSchema`
   - `src/schemas/usage.ts` — `PipelineUsageEventSchema`, `LLMCallDetailSchema`
   - `src/types/index.ts` — re-export all inferred types
   - `src/constants.ts` — port mappings, buffer defaults, performance budgets
7. Initialize `packages/cli/` — `bunx oclif generate kiln` with TypeScript, ESM. Delete default command. Add deps: `@clack/prompts`, `zod`, link `@kiln/shared`
8. Initialize `packages/api/` — `package.json` with `fastify`, `drizzle-orm`, `drizzle-kit`, `@temporalio/client`, `pg`, `bullmq`, `zod`
9. Initialize `packages/grading/` — `package.json` with `@temporalio/workflow`, `@temporalio/activity`, `@anthropic-ai/sdk`, `zod`
10. Initialize `packages/proxy/` — `go.mod`, `main.go` stub, `Dockerfile`
11. Run `bun install` from root — verify `bun.lockb` created, all workspace links resolved
12. Run `bunx turbo build` — verify all TypeScript packages compile
13. Run `bunx turbo lint` — verify Biome passes
14. Create `.gitlab-ci.yml`:
    ```yaml
    stages: [build, test, regression]

    build:
      image: oven/bun:1
      script:
        - bun install --frozen-lockfile
        - bunx turbo build

    test:
      image: oven/bun:1
      script:
        - bun install --frozen-lockfile
        - bunx turbo test

    regression:
      image: oven/bun:1
      script:
        - bun install --frozen-lockfile
        - bun test --filter regression
      rules:
        - changes:
            - packages/grading/src/prompts/**
            - packages/grading/src/activities/generate-one-sheet.ts
            - packages/grading/src/activities/analyze-code.ts
            - packages/grading/src/activities/generate-checkpoint-report.ts
            - packages/grading/src/activities/analyze-code-light.ts
            - packages/shared/src/schemas/one-sheet.ts
            - packages/shared/src/schemas/checkpoint.ts
      allow_failure: false
    ```
15. Create root `vitest.config.ts` (workspace mode) and per-package configs
16. Verify infra: `docker compose -f docker-compose.infra.yml up -d`
    - Temporal UI at `:8080`
    - PostgreSQL at `:5432`
    - Redis at `:6379`
    - SonarQube at `:9000` (default admin/admin, first-boot setup)
17. Create SonarQube project template via API: `POST /api/projects/create` with key `kiln-grading` — verify scanner can analyze a sample project
18. Commit: `"chore: initialize bun monorepo with turbo, biome, vitest, dev infrastructure"`

**Files touched:** root `package.json` (workspaces), `turbo.json`, `biome.json`, `tsconfig.base.json`, `docker-compose.infra.yml`, all `packages/*/package.json`, all `packages/*/tsconfig.json`, `packages/shared/src/**` (including `checkpoint.ts` and `usage.ts` schemas), `packages/proxy/{go.mod,main.go,Dockerfile}`, `.gitlab-ci.yml`

**Validation:**
- `bun install` exits 0, `bun.lockb` exists (no `pnpm-lock.yaml`, no `package-lock.json`)
- `bunx turbo build` exits 0
- `bunx turbo typecheck` exits 0
- `bunx turbo lint` exits 0
- `packages/shared` exports all schemas including `CheckpointReportSchema`, `PipelineUsageEventSchema`, types resolve across workspace links
- SonarQube at `http://localhost:9000` — login works, project created
- Temporal UI at `:8080` — namespace `default` visible
- PostgreSQL: `psql -h localhost -U kiln -d kiln -c "SELECT 1"` returns 1

---

### Phase 2 — Core CLI (init, scaffold, doctor, config)

**Goal:** Implement `kiln init`, `kiln scaffold`, `kiln doctor`, and `kiln config` with Bun-native scaffolding, Clack prompts, multi-cohort awareness, and proxy built from source.

**Steps:**

1. Create `packages/cli/src/commands/init.ts` (oclif Command):
   - Check Docker ≥27.0, Docker Compose ≥2.20, Git ≥2.40, Bun ≥1.0
   - Detect container runtime: OrbStack vs Docker Desktop vs Docker Engine
   - **Runtime discovery (if run inside a project dir):** detect declared runtimes via manifest scan (`package.json` → Node, `requirements.txt`/`pyproject.toml` → Python, `go.mod` → Go, `Cargo.toml` → Rust, `Gemfile` → Ruby) and verify each toolchain is installed at the minimum version declared (or LTS fallback). Missing toolchains produce actionable fix commands (e.g. `brew install python@3.12`, `mise install node@20`).
   - Prompt for `ANTHROPIC_API_KEY` — validate with live Haiku test call (200 OK + latency)
   - Optional: `OPENAI_API_KEY`, `GOOGLE_AI_KEY` (skip allowed)
   - Authenticate against Kiln API: `POST /api/auth/login` or `--token <jwt>`
   - **Retrieve cohort assignment + current week + available projects**: `GET /api/me`
   - Install shell completions via `@oclif/plugin-autocomplete`
   - Write `~/.kiln/config.json`: `{ apiKey, authToken, cohortId, cohortName, currentWeek, containerRuntime, version }`
   - Encrypt credentials: `node:crypto` AES-256-GCM
   - Flags: `--ci`, `--token <jwt>`, `--reset`
   - All errors include fix commands
2. Create `packages/cli/src/commands/doctor.ts`:
   - Re-run all checks non-destructively
   - Check API reachability, GitLab reachability, Anthropic reachability
   - If inside project dir: validate compose, proxy, harness.jsonl
   - **Project-runtime checks (`--project`, default on inside a project dir):** scan manifest files (`package.json`, `requirements.txt`, `pyproject.toml`, `go.mod`, `Cargo.toml`, `Gemfile`), report each declared runtime and whether the host toolchain satisfies the minimum version
   - **Dockerfile/compose presence check:** warn (not fail) if `Dockerfile` or `docker-compose.yml` is missing — include fix hint pointing at `kiln scaffold --adopt` and the Dockerfile guidance in the setup doc
   - Show cohort info: `Cohort: 2026-Q2 (42 students), Week 5`
   - Concise default, `--verbose` for detail
3. Create `packages/cli/src/lib/scaffolder.ts` — Bun-native engine:
   - Use `Bun.file()` + `Bun.write()` for I/O
   - Tagged template literals for substitution
   - `Bun.Glob` for directory traversal
   - Template resolution order: `templates/week-{N}/` overrides → `templates/base/` defaults
   - **Cohort-aware:** scaffold fetches week config from API (`GET /api/cohorts/{id}/weeks/{n}`) to get project title, rubric, template overrides specific to this cohort's project
   - **Mode-aware:** accepts `mode: "greenfield" | "brownfield"`. In brownfield mode, the writer consults a per-file policy — `always-write` (files under `.kiln/`), `merge` (`.env`, `Makefile`), `skip-if-exists` (`Dockerfile`, `docker-compose.yml`, `spec.md`, `rubric.yml`, `README.md`). A `--force` flag flips `skip-if-exists` to `overwrite` with explicit confirmation.
   - **Manifest scanner (`lib/runtime-discovery.ts`):** shared helper used by `init`, `doctor`, `scaffold`, and `audit`. Scans for `package.json`, `requirements.txt`, `pyproject.toml`, `go.mod`, `Cargo.toml`, `Gemfile`, `pom.xml`, `build.gradle*`. Returns `DetectedRuntime[]` = `{ runtime, manifestPath, declaredVersion?, minVersion }`. Each runtime has a probe (`node --version`, `python3 --version`, etc.) and compares against `declaredVersion ?? minVersion`.
4. Create template files in `packages/cli/templates/base/`:
   - `.kiln/proxy/main.go` — full proxy Go source (<500 LOC)
   - `.kiln/proxy/go.mod`, `.kiln/proxy/Dockerfile`
   - `docker-compose.yml.tmpl` — proxy built from source + student services + `develop.watch`
   - `.env.tmpl` — proxy URLs + placeholder keys
   - `.kiln/proxy.yml.tmpl`, `.kiln/rubric.yml.tmpl`, `.kiln/chaos-config.yml.tmpl`
   - `spec.md.tmpl`, `video.md.tmpl`, `Makefile.tmpl`, `README.md.tmpl`
5. Create `packages/cli/templates/week-01/` through `week-04/` — week-specific overrides. **Note:** These are defaults; cohort-specific project configs override via API response.
6. Create `packages/cli/src/commands/scaffold.ts`:
   - Flags: `--week <n>` (required), `--no-docker`, `--no-proxy`, `--ci`, `--template-repo <url>`, `--adopt` (install into current directory instead of creating `week-XX/`), `--force` (overwrite conflicting files — requires explicit opt-in)
   - **Mode detection:** if `--adopt` is set OR the current dir is a non-empty Git repo, run in **brownfield mode** — install only `.kiln/`, `.env` (merged, not overwritten), `spec.md`, `rubric.yml`, and `Makefile` entries into the existing tree. Never touch pre-existing `Dockerfile`, `docker-compose.yml`, `package.json`, or source files unless `--force` is passed.
   - **Conflict reporting:** for every file the scaffold would normally write that already exists, print `skipped (exists): <path>` and point the student at the template copy under `.kiln/templates/` for reference.
   - **Dockerfile/compose detection:** scan for `Dockerfile`, `Containerfile`, `docker-compose.yml`, `compose.yaml` in the repo root. If missing in brownfield mode, print a prominent warning: *"No Dockerfile or docker-compose.yml found — you must add one before `kiln audit` / `kiln submit`. See Adding a Dockerfile in the setup guide."* Scaffold still succeeds.
   - **Runtime discovery:** call the same manifest scanner used by `init`/`doctor`; print detected runtimes and any missing host toolchains as warnings (not blockers).
   - **Fetch cohort-specific week config** from API — project title, rubric, template overrides
   - If API unreachable: fall back to local templates with warning
   - Call `scaffolder.generate()` with week + cohort config + mode (`greenfield` | `brownfield`)
   - Post-scaffold hooks: git init (skip if already a repo), build proxy, pull images, seed data, validate ports, start proxy
   - Outro (greenfield): `cd week-XX && docker compose watch`
   - Outro (brownfield): summary of installed `.kiln/` files, detected runtimes, outstanding Dockerfile/compose gaps, and next command (`kiln doctor` or `docker compose watch`)
7. Create `packages/cli/src/commands/config.ts`:
   - Subcommands: `set <key> <value>`, `get <key>`, `list`
   - Valid keys: `anthropic-key`, `openai-key`, `google-key`, `auth-token`, `cohort`
8. Write tests:
   - `packages/cli/test/commands/init.test.ts` — mock checks, mock API (cohort response), verify config, verify runtime-discovery output for a fixture `package.json` + `requirements.txt` repo
   - `packages/cli/test/commands/scaffold.test.ts` — verify files generated, proxy `build:` context present, `develop.watch` present, cohort-specific rubric applied; verify brownfield mode (fixture with existing `package.json` + no `Dockerfile`) installs `.kiln/`, does NOT touch existing files, prints missing-Dockerfile warning; verify `--force` overrides `skip-if-exists`
   - `packages/cli/test/commands/doctor.test.ts` — verify output includes cohort info, detected runtimes, and Dockerfile-missing warning
   - `packages/cli/test/lib/scaffolder.test.ts` — verify template substitution, cohort override precedence, brownfield file-policy matrix (always-write / merge / skip-if-exists)
   - `packages/cli/test/lib/runtime-discovery.test.ts` — fixtures for Node, Python, Go, Rust, Ruby repos; verify declared-version parsing and min-version comparison
9. Run `bunx turbo test --filter=@kiln/cli`

**Files touched:** `packages/cli/src/commands/{init,scaffold,doctor,config}.ts`, `packages/cli/src/lib/scaffolder.ts`, `packages/cli/templates/**`, tests

**Validation:**
- `kiln init --ci` writes config with `cohortId`, `cohortName`, `currentWeek`, and reports detected runtimes if run inside a project
- `kiln scaffold --week 1 --no-docker --no-proxy` creates dir tree (greenfield)
- `kiln scaffold --week 1 --adopt` inside an existing repo with a `package.json` but no `Dockerfile`: installs `.kiln/`, does not overwrite existing files, prints a missing-Dockerfile warning, exits 0
- `kiln scaffold --week 1 --adopt` inside a repo that already has `docker-compose.yml`: leaves it untouched, prints `skipped (exists)`
- Generated `docker-compose.yml` (greenfield) has `build: context: ./.kiln/proxy` (NOT `image:`)
- Generated rubric matches cohort-specific config (not just default template)
- `kiln doctor` shows cohort info, detected runtimes, and Dockerfile-presence status
- Runtime-discovery fixtures for Node/Python/Go/Rust/Ruby all pass
- All tests pass

---

### Phase 3 — AI Capture System (Proxy + Logs)

**Goal:** Build the kiln-proxy Go source and `proxy` + `logs` CLI commands.

**Steps:**

1. Write `packages/proxy/main.go` — canonical source (scaffold templates copy from here):
   - Read config from env: `ANTHROPIC_UPSTREAM`, `OPENAI_UPSTREAM`, `GOOGLE_UPSTREAM`, `LOG_FILE`, `BUFFER_SIZE_MB`, `FLUSH_INTERVAL_MS`
   - Start 3 HTTP listeners: `:9100`, `:9101`, `:9102`
2. Implement `handler.go`:
   - `httputil.ReverseProxy` per upstream
   - Forward all headers (`Authorization`, `x-api-key`)
   - **SSE stream pass-through:** `io.TeeReader` — pipe chunks to client while copying to capture buffer. NEVER buffer full response.
   - Infer `source_tool` from User-Agent: `claude-code/*` → `claude-code`, `cursor/*` → `cursor`, fallback to port default
   - Persistent HTTPS connection pool per upstream
3. Implement `capture.go`:
   - Ring buffer (32MB default)
   - Serialize each interaction to JSONL matching `HarnessLogEntrySchema`
   - Extract only `model` field from request body (no full parse)
   - Non-blocking push to buffer; drop oldest on overflow with stderr warning
4. Implement `flusher.go`:
   - Background goroutine: flush every 100ms OR at 64KB
   - Append-only JSONL, fsync per batch
   - Never blocks handler
5. Health endpoint: `GET /healthz` → `{"status":"ok","interactions":N}`
6. Dockerfile: multi-stage Go build → scratch runtime, <10MB
7. Sync proxy source to scaffold templates: `packages/cli/templates/base/.kiln/proxy/` ← copy from `packages/proxy/`
8. Create CLI commands:
   - `proxy/start.ts` — `docker compose up -d kiln-proxy`, wait for health (10s timeout)
   - `proxy/stop.ts` — `docker compose stop kiln-proxy`
   - `proxy/status.ts` — query health endpoints, read harness.jsonl stats
9. Create `logs/analyze.ts`:
   - Parse `.kiln/harness.jsonl`, validate against schema
   - Call Haiku (`claude-haiku-4-5-20251001`) with summary + samples
   - Output: sophistication, context curation, tool selection, modification rate
   - Error if 0 interactions — suggest `kiln proxy start`
10. Write tests (Go + TypeScript), build image, smoke test
11. Smoke test: start proxy, mock upstream, send request to `:9100`, verify JSONL entry

**Files touched:** `packages/proxy/**`, `packages/cli/src/commands/proxy/**`, `packages/cli/src/commands/logs/analyze.ts`, scaffold template sync

**Validation:**
- `docker build -t kiln-proxy:test packages/proxy/` — image <10MB
- Health endpoint responds on all 3 ports
- JSONL validates against `HarnessLogEntrySchema`
- SSE: client receives first chunk within 5ms of upstream emit
- Ring buffer overflow: graceful drop, no crash
- `kiln proxy status` reports correct count

---

### Phase 4 — Chaos & Validation System

**Goal:** Implement `kiln chaos` with Pumba + Toxiproxy + steady-state verification, and `kiln audit`.

**Steps:**

1. Create `packages/cli/src/lib/chaos/pumba.ts` — Docker wrapper (kill, stress, pause). Filter out `kiln.chaos.exclude` containers.
2. Create `packages/cli/src/lib/chaos/toxiproxy.ts` — REST client (latency, disconnect, removeAll)
3. Create `packages/cli/src/lib/chaos/steady-state.ts` — reads `.kiln/chaos-config.yml`, checks endpoints, returns `PASS|FAIL|DEGRADED`
4. Create chaos commands:
   - `chaos/latency.ts` — `--target`, `--delay`, `--jitter`, `--duration`, `--verify`
   - `chaos/kill.ts` — `--target`, `--in`
   - `chaos/stress.ts` — `--target`, `--cpu`, `--duration`
   - `chaos/disconnect.ts` — `--target`, `--duration`
   - `chaos/profile.ts` — reads `.kiln/chaos-profiles/week-XX.yml` (**visible set only** — the hidden set is server-side and never shipped to students), runs sequence, always verifies. Output clearly labels results as `profile_kind: "visible"` so students understand the grader will additionally run an unseen hidden set on final submission.
5. Create `packages/cli/src/commands/audit.ts`:
   - Required file checks (8 files per PRD)
   - **Dockerfile + compose presence (hard fail):** at least one of `Dockerfile` / `Containerfile` AND one of `docker-compose.yml` / `compose.yaml` must exist at the repo root. Fix command: *"Add a Dockerfile — see `docs/adding-a-dockerfile.md` or your setup guide"*.
   - **Dockerfile buildability (hard fail):** `docker compose build` must complete successfully within the audit timeout. Failure surfaces the last 40 lines of build output + fix command.
   - **Runtime-toolchain parity check:** call the shared manifest scanner; any declared runtime whose host toolchain is missing or below min version is a hard fail with a fix command.
   - Docker build + health check
   - Capture integrity: schema validation, per-tool counts, timestamp span, git cross-reference, payload completeness, plausibility check
   - Secret scan: `sk-ant-`, `sk-`, `glpat-` in Docker layers
   - Default concise, `--verbose` full, `--fix` for trivials
   - Every failure includes fix command
6. Create `packages/cli/src/lib/audit/soft-audit.ts`:
   - **Same checks as `kiln audit` but failures are warnings, not blockers.** Used by `kiln checkpoint`.
   - Hard requirements: Git repo initialized, at least one source file exists, proxy config present.
   - **Dockerfile/compose gaps surface as `evaluation_coverage` downgrades** — checkpoint report shows `docker_build: "skipped (no Dockerfile)"` and the affected rubric criteria are marked `blocked` rather than failing the run.
   - **Missing runtime toolchains surface as warnings**, not blockers (student may be on a different machine than the grader).
   - Returns warnings list for display in checkpoint report.
7. Write tests for all chaos + audit commands (including soft-audit)
8. Run `bunx turbo test --filter=@kiln/cli`

**Files touched:** `packages/cli/src/lib/chaos/**`, `packages/cli/src/commands/chaos/**`, `packages/cli/src/commands/audit.ts`, `packages/cli/src/lib/audit/soft-audit.ts`

**Validation:**
- `kiln chaos latency --verify` completes with verdict
- Chaos never targets `kiln.chaos.exclude` containers
- `kiln audit` (valid) exits 0 concise; (incomplete) exits 1 with fix commands
- `kiln audit` on a repo with no `Dockerfile` → exits 1 with a hard-fail line pointing at the Dockerfile fix command
- `kiln audit` on a repo whose `docker compose build` fails → exits 1 with build-log tail
- `kiln audit` on a repo declaring Python 3.12 in `pyproject.toml` on a host with Python 3.9 → exits 1 with toolchain fix command
- Soft audit returns warnings instead of blocking — used by checkpoint flow
- Soft audit on a repo with no `Dockerfile` → exits 0, checkpoint report shows `docker_build: "skipped (no Dockerfile)"` and affected criteria marked `blocked`
- Chaos results validate against `ChaosResultSchema`

---

### Phase 5 — Grading Pipeline

**Goal:** Implement the Temporal-orchestrated grading pipeline with multi-cohort support, SonarQube + LLM hybrid code analysis, 3-pass one-sheet generation, and Fly Volume storage.

**Steps:**

1. Create PostgreSQL schema — `packages/api/src/db/schema.ts` (Drizzle):
   ```typescript
   // Multi-cohort data model
   export const cohorts = pgTable("cohorts", {
     id: uuid("id").primaryKey().defaultRandom(),
     name: varchar("name", { length: 255 }).notNull(),        // "2026-Q2-Backend"
     description: text("description"),
     startDate: date("start_date").notNull(),
     endDate: date("end_date"),
     maxStudents: integer("max_students").default(100),
     config: jsonb("config").default({                         // Cohort-level config
       checkpoint_retention_days: 7,
       checkpoints_enabled: true,
     }),
     createdAt: timestamp("created_at").defaultNow(),
   });

   export const weeks = pgTable("weeks", {
     id: uuid("id").primaryKey().defaultRandom(),
     cohortId: uuid("cohort_id").references(() => cohorts.id).notNull(),
     weekNumber: integer("week_number").notNull(),
     title: varchar("title", { length: 255 }).notNull(),      // "Circuit Breakers"
     projectSlug: varchar("project_slug", { length: 100 }),    // "circuit-breakers"
     rubricYaml: text("rubric_yaml").notNull(),                // Full rubric YAML
     rubricVersion: varchar("rubric_version", { length: 64 }), // SHA-256 hash
     templateRepoUrl: text("template_repo_url"),               // Cohort-specific template
     templateOverrides: jsonb("template_overrides"),            // JSON overrides for base templates
     visibleChaosYaml: text("visible_chaos_yaml"),              // Visible chaos profile — also shipped in student scaffold as .kiln/chaos-profiles/week-XX.yml
     hiddenChaosYaml: text("hidden_chaos_yaml"),                // SERVER-SIDE ONLY. Never returned to student endpoints. Injected into grading pipeline on stage="final".
     isActive: boolean("is_active").default(true),
     createdAt: timestamp("created_at").defaultNow(),
   }, (t) => ({
     uniqueWeek: unique().on(t.cohortId, t.weekNumber),       // One week-3 per cohort
   }));

   export const users = pgTable("users", {
     id: uuid("id").primaryKey().defaultRandom(),
     email: varchar("email", { length: 255 }).unique().notNull(),
     name: varchar("name", { length: 255 }).notNull(),
     role: varchar("role", { length: 20 }).notNull(),          // "student" | "grader" | "admin"
     createdAt: timestamp("created_at").defaultNow(),
   });

   // Many-to-many: users belong to cohorts with a role
   export const cohortMembers = pgTable("cohort_members", {
     id: uuid("id").primaryKey().defaultRandom(),
     userId: uuid("user_id").references(() => users.id).notNull(),
     cohortId: uuid("cohort_id").references(() => cohorts.id).notNull(),
     role: varchar("role", { length: 20 }).notNull(),          // "student" | "grader"
     joinedAt: timestamp("joined_at").defaultNow(),
   }, (t) => ({
     uniqueMembership: unique().on(t.userId, t.cohortId),
   }));

   export const submissions = pgTable("submissions", {
     id: uuid("id").primaryKey().defaultRandom(),
     userId: uuid("user_id").references(() => users.id).notNull(),
     weekId: uuid("week_id").references(() => weeks.id).notNull(),
     type: varchar("type", { length: 20 }).notNull().default("final"),
       // "final" | "checkpoint"  (pipeline variant: full grading vs reduced checkpoint)
     stage: varchar("stage", { length: 10 }),
       // "early" | "final"  — only meaningful when type="final".
       // "early" = Thursday dress rehearsal, runs full pipeline MINUS hidden chaos set.
       // "final" = Saturday graded run, includes hidden chaos set.
       // Null for type="checkpoint".
     repoUrl: text("repo_url").notNull(),
     commitSha: varchar("commit_sha", { length: 40 }).notNull(),
     videoUrl: text("video_url"),
     status: varchar("status", { length: 20 }).notNull().default("queued"),
       // "queued" | "processing" | "graded" | "failed"
     submittedAt: timestamp("submitted_at").defaultNow(),
   });

   export const gradingResults = pgTable("grading_results", {
     id: uuid("id").primaryKey().defaultRandom(),
     submissionId: uuid("submission_id").references(() => submissions.id).notNull(),
     oneSheet: jsonb("one_sheet").notNull(),                   // Full OneSheetSchema JSON
     sonarMetrics: jsonb("sonar_metrics"),                     // SonarQube raw metrics
     overallScore: real("overall_score").notNull(),
     overallGrade: varchar("overall_grade", { length: 2 }).notNull(),
     rubricVersion: varchar("rubric_version", { length: 64 }).notNull(),
     promptVersion: varchar("prompt_version", { length: 64 }).notNull(),
     modelVersion: varchar("model_version", { length: 64 }).notNull(),
     proxyVersion: varchar("proxy_version", { length: 64 }),
     createdAt: timestamp("created_at").defaultNow(),
   });

   export const graderOverrides = pgTable("grader_overrides", {
     id: uuid("id").primaryKey().defaultRandom(),
     gradingResultId: uuid("grading_result_id").references(() => gradingResults.id).notNull(),
     graderId: uuid("grader_id").references(() => users.id).notNull(),
     criterion: varchar("criterion", { length: 100 }).notNull(),
     aiScore: real("ai_score").notNull(),
     humanScore: real("human_score").notNull(),
     rationale: text("rationale").notNull(),
     createdAt: timestamp("created_at").defaultNow(),
   });

   // --- Checkpoint tables ---

   export const checkpoints = pgTable("checkpoints", {
     id: uuid("id").primaryKey().defaultRandom(),
     submissionId: uuid("submission_id").references(() => submissions.id).notNull(),
     report: jsonb("report").notNull(),               // CheckpointReportSchema JSON
     sonarMetrics: jsonb("sonar_metrics"),
     rubricVersion: varchar("rubric_version", { length: 64 }).notNull(),
     promptVersion: varchar("prompt_version", { length: 64 }).notNull(),
     modelVersion: varchar("model_version", { length: 64 }).notNull(),
     expiresAt: timestamp("expires_at").notNull(),    // Default: created_at + 7 days
     createdAt: timestamp("created_at").defaultNow(),
   });

   // --- Usage & cost metrics tables ---

   export const pipelineUsageEvents = pgTable("pipeline_usage_events", {
     id: uuid("id").primaryKey().defaultRandom(),
     cohortId: uuid("cohort_id").references(() => cohorts.id).notNull(),
     weekId: uuid("week_id").references(() => weeks.id).notNull(),
     userId: uuid("user_id").references(() => users.id).notNull(),
     submissionId: uuid("submission_id").references(() => submissions.id).notNull(),
     pipelineType: varchar("pipeline_type", { length: 20 }).notNull(),  // "grading" | "checkpoint"
     startedAt: timestamp("started_at").notNull(),
     completedAt: timestamp("completed_at"),
     status: varchar("status", { length: 20 }).notNull(),
     durationMs: integer("duration_ms").notNull(),
     // LLM usage
     llmCalls: jsonb("llm_calls").notNull(),          // Array<LLMCallDetail>
     totalInputTokens: integer("total_input_tokens").notNull(),
     totalOutputTokens: integer("total_output_tokens").notNull(),
     totalCacheReadTokens: integer("total_cache_read_tokens").notNull().default(0),
     totalCacheWriteTokens: integer("total_cache_write_tokens").notNull().default(0),
     totalEstimatedCostUsd: real("total_estimated_cost_usd").notNull(),
     // Infrastructure
     sonarqubeScanDurationMs: integer("sonarqube_scan_duration_ms"),
     dockerBuildDurationMs: integer("docker_build_duration_ms"),
     gitCloneDurationMs: integer("git_clone_duration_ms"),
     artifactStorageBytes: integer("artifact_storage_bytes").notNull().default(0),
     // Versions
     promptVersion: varchar("prompt_version", { length: 64 }).notNull(),
     modelVersion: varchar("model_version", { length: 64 }).notNull(),
     rubricVersion: varchar("rubric_version", { length: 64 }).notNull(),
     createdAt: timestamp("created_at").defaultNow(),
   });

   export const usageDailyRollups = pgTable("usage_daily_rollups", {
     id: uuid("id").primaryKey().defaultRandom(),
     cohortId: uuid("cohort_id").references(() => cohorts.id).notNull(),
     date: date("date").notNull(),
     pipelineType: varchar("pipeline_type", { length: 20 }).notNull(),
     totalRuns: integer("total_runs").notNull(),
     successfulRuns: integer("successful_runs").notNull(),
     failedRuns: integer("failed_runs").notNull(),
     uniqueStudents: integer("unique_students").notNull(),
     totalInputTokens: bigint("total_input_tokens", { mode: "number" }).notNull(),
     totalOutputTokens: bigint("total_output_tokens", { mode: "number" }).notNull(),
     totalCacheReadTokens: bigint("total_cache_read_tokens", { mode: "number" }).notNull(),
     totalEstimatedCostUsd: real("total_estimated_cost_usd").notNull(),
     avgDurationMs: integer("avg_duration_ms").notNull(),
     p95DurationMs: integer("p95_duration_ms").notNull(),
     avgArtifactStorageBytes: integer("avg_artifact_storage_bytes").notNull(),
     createdAt: timestamp("created_at").defaultNow(),
   }, (t) => ({
     uniqueRollup: unique().on(t.cohortId, t.date, t.pipelineType),
   }));

   export const usageAlerts = pgTable("usage_alerts", {
     id: uuid("id").primaryKey().defaultRandom(),
     cohortId: uuid("cohort_id").references(() => cohorts.id),  // null = global alert
     alertType: varchar("alert_type", { length: 50 }).notNull(),
       // "high_cost_student" | "cache_degradation" | "failure_spike" | "spend_spike" | "model_misuse"
     severity: varchar("severity", { length: 10 }).notNull(),   // "info" | "warning" | "critical"
     title: varchar("title", { length: 255 }).notNull(),
     detail: text("detail").notNull(),
     acknowledgedAt: timestamp("acknowledged_at"),
     createdAt: timestamp("created_at").defaultNow(),
   });

   // --- Artifact dispatch tables ---

   export const dispatchTargets = pgTable("dispatch_targets", {
     id: uuid("id").primaryKey().defaultRandom(),
     cohortId: uuid("cohort_id").references(() => cohorts.id).notNull(),
     weekId: uuid("week_id").references(() => weeks.id),           // null = cohort-wide default
     name: varchar("name", { length: 100 }).notNull(),             // "kiln-portal"
     url: text("url").notNull(),                                    // https endpoint
     authMode: varchar("auth_mode", { length: 20 }).notNull(),      // "bearer" | "hmac" | "none"
     authSecretRef: varchar("auth_secret_ref", { length: 200 }),    // env/secret name, never inline
     artifactSelectors: jsonb("artifact_selectors").notNull(),      // ["one_sheet", "ai_usage", ...]
     transformTemplate: text("transform_template"),                 // optional JS/JSONata mapping
     retryPolicy: jsonb("retry_policy").notNull().default({
       maxAttempts: 5,
       backoffSeconds: [1, 4, 16, 64, 256],
     }),
     triggerOn: jsonb("trigger_on").notNull().default(["final"]),  // ["final"] | ["final","checkpoint"]
     enabled: boolean("enabled").notNull().default(true),
     createdAt: timestamp("created_at").defaultNow(),
     updatedAt: timestamp("updated_at").defaultNow(),
   }, (t) => ({
     uniqueTargetName: unique().on(t.cohortId, t.weekId, t.name),
   }));

   export const dispatchEvents = pgTable("dispatch_events", {
     id: uuid("id").primaryKey().defaultRandom(),
     targetId: uuid("target_id").references(() => dispatchTargets.id).notNull(),
     submissionId: uuid("submission_id").references(() => submissions.id).notNull(),
     cohortId: uuid("cohort_id").references(() => cohorts.id).notNull(), // denormalized for scoped queries
     attempt: integer("attempt").notNull(),
     status: varchar("status", { length: 20 }).notNull(),
       // "pending" | "success" | "retrying" | "failed" | "dead_letter"
     httpStatus: integer("http_status"),
     latencyMs: integer("latency_ms"),
     error: text("error"),
     payloadBytes: integer("payload_bytes").notNull().default(0),
     responseRef: text("response_ref"),                             // e.g. Portal job id
     createdAt: timestamp("created_at").defaultNow(),
   });
   ```

2. Create migrations:
   - `packages/api/drizzle/0001_init.sql` — core tables (cohorts, weeks, users, cohort_members, submissions, grading_results, grader_overrides)
   - `packages/api/drizzle/0002_checkpoints.sql` — checkpoints table, `type` column on submissions
   - `packages/api/drizzle/0003_usage_metrics.sql` — pipeline_usage_events, usage_daily_rollups, usage_alerts
   - `packages/api/drizzle/0004_hidden_chaos_and_stage.sql` — `weeks.visible_chaos_yaml`, `weeks.hidden_chaos_yaml`, `submissions.stage`
   - `packages/api/drizzle/0005_dispatch.sql` — dispatch_targets, dispatch_events
3. Create `packages/api/src/db/index.ts` — Drizzle client with connection pool
4. Create `packages/api/src/lib/storage.ts` — filesystem storage:
   ```typescript
   // Fly Volume at /data/ in prod, ./data/ in dev
   // Grading artifacts: /data/cohorts/{cohortId}/submissions/{submissionId}/
   // Checkpoint artifacts: /data/cohorts/{cohortId}/checkpoints/{checkpointId}/
   export async function storeArtifact(
     cohortId: string,
     entityType: "submissions" | "checkpoints",
     entityId: string,
     filename: string,
     content: Buffer | string
   ): Promise<string> {
     const base = process.env.STORAGE_PATH || "./data";
     const dir = path.join(base, "cohorts", cohortId, entityType, entityId);
     await mkdir(dir, { recursive: true });
     const fp = path.join(dir, filename);
     await writeFile(fp, content);
     return fp;
   }
   ```
5. Create `packages/api/src/server.ts` — Fastify:
   - `POST /api/submissions` — validate body `{ repoUrl, commitSha, weekNumber, stage: "early" | "final" }` (stage defaults to `"final"`), resolve `weekId` from cohort+week, insert with `type: "final"` and the requested `stage`, start Temporal grading workflow with `stage` in workflow input. Rejects `stage: "early"` after the early deadline has passed for that cohort+week.
   - `POST /api/webhooks/gl` — verify `X-Gitlab-Token`, parse push payload, resolve student+week from repo URL pattern, insert, start workflow
   - `GET /api/results/:id` — fetch result (scoped: student sees own, grader sees cohort)
   - `GET /api/status/:job_id` — Temporal workflow progress
   - `GET /api/me` — return user's cohort, current week, role
   - **Checkpoint routes**:
     - `POST /api/checkpoints` — validate body `{ repoUrl, commitSha, weekNumber }`, resolve cohort from JWT, verify checkpoints enabled for cohort, insert submission with `type: "checkpoint"`, start Temporal checkpoint workflow, return `{ checkpointId, jobId }`
     - `GET /api/checkpoints/:id` — fetch checkpoint report (student sees own, grader sees cohort)
     - `GET /api/checkpoints/history` — all checkpoints for current student+week, ordered by `created_at`
   - **Admin routes:**
     - `POST /api/admin/cohorts` — create cohort
     - `POST /api/admin/cohorts/:id/weeks` — create/update week config (rubric, template, project, visible chaos profile)
     - `PATCH /api/admin/cohorts/:id/weeks/:n/hidden-chaos` — upload/update the **server-side hidden chaos profile** for that cohort+week. Admin-only. YAML validated against the same schema as the visible profile. Validator rejects if hidden profile uses different fault categories or steady-state criteria than the visible profile (enforces "same rules, unseen permutations").
     - `POST /api/admin/cohorts/:id/members` — add students/graders (bulk)
     - `GET /api/admin/cohorts/:id/submissions` — all submissions for cohort+week
     - `GET /api/admin/cohorts/:id/analytics` — cohort-level score distributions
     - `PATCH /api/admin/cohorts/:id/checkpoint-config` — set checkpoint retention, enable/disable
   - **Dispatch admin routes:**
     - `GET /api/admin/cohorts/:id/dispatch/targets` — list targets for cohort (optionally filter by `week`)
     - `POST /api/admin/cohorts/:id/dispatch/targets` — create target (validated against `DispatchTargetSchema`)
     - `PATCH /api/admin/dispatch/targets/:targetId` — update (partial), flip `enabled`
     - `DELETE /api/admin/dispatch/targets/:targetId` — soft delete (sets `enabled=false`; history preserved)
     - `POST /api/admin/dispatch/targets/:targetId/test` — synthetic dispatch with a sample payload, no DB write
     - `GET /api/admin/dispatch/events` — list events, filterable by `cohort_id`, `target_id`, `submission_id`, `status`
     - `POST /api/admin/dispatch/redispatch` — body `{ submissionId, targetId }`; enqueues a fresh dispatch child workflow
   - **Usage admin routes**:
     - `GET /api/admin/usage/summary` — global summary (total spend, runs, cost by pipeline type and model, cache hit rate). Query params: `from`, `to`
     - `GET /api/admin/usage/cohorts/:id` — per-cohort breakdown (daily spend curve, per-week totals, checkpoint vs grading split). Query params: `from`, `to`, `week`
     - `GET /api/admin/usage/cohorts/:id/students` — per-student usage sorted by cost
     - `GET /api/admin/usage/cohorts/:id/weeks/:n` — per-week drilldown (pass-level breakdown, SonarQube/Docker times, cache efficiency, failure rate)
     - `GET /api/admin/usage/alerts` — active alerts
     - `GET /api/admin/usage/forecast` — projected spend. Query param: `cohort_id` (optional)
     - `GET /api/admin/usage/export` — CSV export of raw pipeline_usage_events. Query params: `from`, `to`, `cohort_id`
   - Auth middleware: JWT with `cohortId` + `role` claims. Queries always filter by cohort.
6. Create Temporal grading workflow — `packages/grading/src/workflows/grade-submission.ts`:
   ```
   Input: { submissionId, repoUrl, commitSha, weekId, cohortId, rubricYaml, stage: "early" | "final", visibleChaosYaml, hiddenChaosYaml }

   ① cloneRepo(repoUrl, commitSha) → workspacePath
   ② buildDocker(workspacePath)     → buildResult      [depends on ①]
   ③ runTests(workspacePath, visibleChaosYaml, hiddenChaosYaml, stage) → testResults      [depends on ②]
   ④ normalizeLogs(workspacePath)    → normalizedLogs   [depends on ①, PARALLEL with ②③]
   ⑤ analyzeCode(workspacePath, testResults, rubricYaml) → codeAnalysis [depends on ③]
   ⑥ generateOneSheet(normalizedLogs, codeAnalysis, testResults, rubricYaml) → oneSheet [depends on ④⑤]
   ⑦ storeResults(submissionId, cohortId, oneSheet, sonarMetrics, usageDetails) → done [depends on ⑥]
   ```
   - **Rubric is passed as input** — each cohort+week has its own rubric.
   - Prompt caching key is `cohortId + weekNumber` — students in the same cohort share cached prefix.
   - **Step ⑦ emits a `pipeline_usage_events` row** with accumulated LLM call details, durations, and cost estimates.
7. Create grading activities:
   - `clone-repo.ts` — `git clone --depth 1`. **Instrumented:** records `git_clone_duration_ms`.
   - `build-docker.ts` — `docker compose build`, 5-min timeout, 1GB limit. **Instrumented:** records `docker_build_duration_ms`.
     - **Missing `Dockerfile`/`docker-compose.yml`** → return `{ status: "missing", reason, affectedCriteria: ["Ships", "Resilience"] }`. Workflow continues to code analysis so the student still gets rubric-aware feedback, but the Ships criterion is scored 0 with the reason surfaced in the one-sheet's `evaluation_coverage` + talking points.
     - **Build failure** → return `{ status: "failed", exitCode, logsTail, affectedCriteria: ["Ships"] }`. Same pattern — graded failure, not workflow crash. Last 40 lines of build output captured for the one-sheet.
     - Both outcomes are distinct from Temporal activity failure (which should only fire for infra issues, e.g. Docker daemon unreachable).
   - `run-tests.ts` — compose up, health check, test harness. Runs chaos profiles in order: (1) visible profile from `visibleChaosYaml` (always), (2) hidden profile from `hiddenChaosYaml` ONLY when `stage === "final"`. Captures results into a labeled structure `{ visible: ChaosResult[], hidden: ChaosResult[] | null }`. Both sets are passed downstream to `analyze-code` and `generate-one-sheet` with their labels preserved so the grader LLM can weight hidden-set performance specifically against the Resilience axis. When `stage === "early"`, `hidden` is `null` and the one-sheet's Resilience section is marked `"dress_rehearsal"`.
   - `normalize-logs.ts` — parse JSONL, classify, chain, index, flag gaps
   - **`analyze-code.ts` — SonarQube + LLM hybrid:**
     a. Run SonarQube scanner against workspace:
        ```typescript
        execSync(`sonar-scanner \
          -Dsonar.projectKey=submission-${submissionId} \
          -Dsonar.sources=src \
          -Dsonar.host.url=${SONAR_URL} \
          -Dsonar.token=${SONAR_TOKEN}`, { cwd: workspacePath });
        ```
        **Instrumented:** records `sonarqube_scan_duration_ms`.
     b. Parse SonarQube metrics into `SonarMetricsSchema` (complexity, duplication, code_smells, bugs, vulnerabilities, coverage, sqale_rating)
     c. Call Claude Sonnet 4.6 via `trackedLLMCall()` with SonarQube metrics as evidence + source code + rubric Code Craft criteria
     d. Clean up SonarQube project: `DELETE /api/projects/delete?project=submission-${submissionId}`
   - `generate-one-sheet.ts` — 3-pass pipeline, all LLM calls via `trackedLLMCall()`:
     a. **Pass 1 — Extraction** (Sonnet 4.6): `trackedLLMCall(client, params, "pass1-extraction")`
     b. **Pass 2 — Pointwise Rubric Evaluation** (Sonnet 4.6): `trackedLLMCall(client, params, "pass2-rubric-eval")` — prompt explicitly instructs the model that the **Resilience axis (25%)** must be scored primarily from hidden-set chaos results when present, with visible-set results used only as a sanity check. Reason: visible set is student-runnable and therefore prone to overfitting.
     c. **Pass 3 — Synthesis** (Opus 4.6): `trackedLLMCall(client, params, "pass3-synthesis")` → `zodOutputFormat(OneSheetSchema)`
     d. Validate citations post-generation. When `stage === "early"`, synthesis output tags the Resilience axis as `"dress_rehearsal"` and notes hidden-set results will determine the final Resilience score.
     e. **Prompt caching:** shared prefix = rubric + grading instructions. Cache key = `cohortId + weekNumber`.
   - `store-results.ts`:
     a. Insert into `grading_results` with JSONB one-sheet + `sonar_metrics`
     b. `storeArtifact(cohortId, "submissions", submissionId, ...)` — logs, one-sheet, build logs to Fly Volume
     c. Record `rubric_version`, `prompt_version`, `model_version`
     d. **Emit `pipeline_usage_events` row** with accumulated `llmCallDetails[]`, durations, and cost estimate
     e. **If `submission.type === "final"` AND `submission.stage === "final"`:** start child Temporal workflow `dispatch-artifacts` with `{ submissionId, cohortId, weekId, trigger: "final" }`. Use `ParentClosePolicy.ABANDON` — dispatch continues even if parent workflow is closing. Failures are swallowed at this boundary (logged only) — dispatch must never fail the grading pipeline. Early submissions do NOT dispatch.
     f. Notify student
8. Create `packages/grading/src/lib/tracked-llm-call.ts`:
   ```typescript
   import Anthropic from "@anthropic-ai/sdk";
   import { LLMCallDetailSchema } from "@kiln/shared";

   export async function trackedLLMCall(
     client: Anthropic,
     params: Anthropic.MessageCreateParams,
     purpose: string,
   ): Promise<{ message: Anthropic.Message; detail: z.infer<typeof LLMCallDetailSchema> }> {
     const start = performance.now();
     const message = await client.messages.create(params);
     const latency = performance.now() - start;

     const detail = LLMCallDetailSchema.parse({
       call_id: crypto.randomUUID(),
       model: params.model,
       purpose,
       input_tokens: message.usage.input_tokens,
       output_tokens: message.usage.output_tokens,
       cache_read_tokens: message.usage.cache_read_input_tokens ?? 0,
       cache_write_tokens: message.usage.cache_creation_input_tokens ?? 0,
       latency_ms: Math.round(latency),
       estimated_cost_usd: estimateCost(
         params.model,
         message.usage.input_tokens,
         message.usage.output_tokens,
         message.usage.cache_read_input_tokens ?? 0,
         message.usage.cache_creation_input_tokens ?? 0,
       ),
     });

     return { message, detail };
   }
   ```
9. Create `packages/grading/src/lib/pricing.ts`:
   - Lookup table: `(model, token_type) → cost_per_1M_tokens`
   - Sourced from Anthropic's published pricing page
   - `PRICING_LAST_UPDATED` constant for staleness visibility
   - `estimateCost()` function used by `trackedLLMCall()`
10. Create `packages/grading/src/prompts/`:
    - `cached-prefix.txt` — accepts `{{rubric}}` placeholder, filled per cohort+week
    - `pass1-extraction.txt`
    - `pass2-rubric-eval.txt`
    - `pass3-synthesis.txt`
    - `code-analysis.txt` — includes SonarQube metrics integration instructions
11. Create `packages/grading/src/lib/prompt-versioning.ts`:
    - SHA-256 hash of each prompt file
    - SHA-256 hash of rubric YAML
    - Record in every grading result and usage event
12. Create CLI submission commands:
    - `submit.ts` — audit → `git push` → POST with `cohortId` from config → job ID
    - `status.ts` — step progress
    - `results.ts` — display one-sheet (includes SonarQube metrics summary)
13. Write tests:
    - `analyze-code.test.ts` — mock SonarQube API + mock Sonnet via `trackedLLMCall`, verify hybrid flow, verify metrics passed to LLM prompt, verify `LLMCallDetail` recorded
    - `generate-one-sheet.test.ts` — mock Claude API via `trackedLLMCall`, verify 3-pass, verify cohort-specific rubric used, verify all calls produce detail records
    - `tracked-llm-call.test.ts` — verify token capture, cost estimation, detail schema validation
    - `pricing.test.ts` — verify cost calculation for known token counts
    - `grade-submission.test.ts` — mock activities, verify ④ parallel with ②③, verify cohort isolation, verify usage event emitted
    - `submissions.test.ts` — verify cohort scoping (student A in cohort 1 cannot see cohort 2 results)
    - `webhooks.test.ts` — verify GitLab token validation, repo→student+week resolution
14. Integration test: two cohorts with different rubrics → submit to each → verify different rubrics applied → verify results scoped correctly → verify usage events recorded for both

**Files touched:** `packages/api/src/**`, `packages/grading/src/**`, `packages/grading/src/prompts/**`, `packages/grading/src/lib/{tracked-llm-call,pricing}.ts`, `packages/cli/src/commands/{submit,status,results}.ts`

**Validation:**
- `bunx drizzle-kit push` applies all migrations — `cohorts`, `weeks`, `cohort_members`, `submissions`, `grading_results`, `grader_overrides`, `checkpoints`, `pipeline_usage_events`, `usage_daily_rollups`, `usage_alerts` tables all present
- `submissions` table has `type` column (`"final"` | `"checkpoint"`) and `stage` column (`"early"` | `"final"` | null)
- `weeks` table has `visible_chaos_yaml` and `hidden_chaos_yaml` columns
- `run-tests` activity: submitting `stage: "early"` runs visible chaos only; submitting `stage: "final"` runs visible + hidden; captured results are labeled
- Hidden chaos YAML is never returned by `GET /api/me`, `GET /api/cohorts/:id/weeks/:n`, scaffold API, or any student-facing route — integration test asserts 0 bytes of hidden YAML in all student-scoped responses
- `PATCH /api/admin/cohorts/:id/weeks/:n/hidden-chaos` with a hidden profile using a fault category not in the visible profile → rejected with 400
- SonarQube scanner runs on sample project, metrics returned via API, project cleaned up after
- LLM code analysis prompt includes SonarQube metrics as structured evidence
- All LLM calls go through `trackedLLMCall()` — verify by checking usage event contains LLM call details with correct `purpose` tags
- Temporal workflow completes, ④ parallel with ②③
- One-sheet validates against `OneSheetSchema`
- **Cohort isolation:** create 2 cohorts with different rubrics for week 1. Submit to each. Verify different rubrics applied. Verify student in cohort A cannot fetch results from cohort B via API.
- Prompt caching: same cohort+week students share cached prefix (verify `cache_read_input_tokens`)
- Usage event row present after pipeline completion with correct token counts and cost estimate
- Pipeline <3 min per submission
- GitLab webhook triggers pipeline

---

### Phase 6 — Checkpoint System

**Goal:** Implement the student-initiated checkpoint pipeline for formative, mid-project feedback. Checkpoints use a reduced Temporal workflow (best-effort build/test, single Sonnet pass) and produce a rubric-aware gap analysis in <90s.

**Steps:**

1. Write `packages/grading/src/workflows/checkpoint-submission.ts` — reduced workflow:
   ```
   Input: { submissionId, repoUrl, commitSha, weekId, cohortId, rubricYaml, type: "checkpoint" }

   ① cloneRepo(repoUrl, commitSha) → workspacePath
   ② tryBuildDocker(workspacePath)   → buildResult | null     [best-effort, 2-min timeout]
   ③ tryRunTests(workspacePath)      → testResults | null      [best-effort, depends on ②]
   ④ normalizeLogs(workspacePath)    → normalizedLogs          [PARALLEL with ②③]
   ⑤ analyzeCodeLight(workspacePath, testResults?, rubricYaml) → codeAnalysis [depends on ②③④]
   ⑥ generateCheckpointReport(normalizedLogs, codeAnalysis, testResults?, rubricYaml) → report [depends on ④⑤]
   ⑦ storeCheckpoint(submissionId, cohortId, report, usageDetails) → done [depends on ⑥]
   ```
   Key differences from full grading workflow:
   - Steps ② and ③ are best-effort — nullable results, workflow continues on failure
   - Step ⑤ uses `analyzeCodeLight` — SonarQube metrics + single shorter Sonnet call focused on gap identification
   - Step ⑥ is a single-pass generation (Sonnet 4.6), not the 3-pass extraction→evaluation→synthesis pipeline
   - Step ⑦ stores in `checkpoints` table with `expires_at` TTL, and emits a `pipeline_usage_events` row with `pipeline_type: "checkpoint"`
   - Total target: <90s wall-clock

2. Write `packages/grading/src/activities/analyze-code-light.ts`:
   - Extract SonarQube scanning logic into shared helper (from `analyze-code.ts`) — avoids duplication
   - Run SonarQube scanner (same as full pipeline — metrics are fast and useful even on incomplete code)
   - Single Sonnet call via `trackedLLMCall(client, params, "checkpoint-code-analysis")` with shorter prompt focused on gap identification
   - Clean up SonarQube project (same pattern: `DELETE /api/projects/delete?project=checkpoint-${submissionId}`)

3. Write `packages/grading/src/activities/generate-checkpoint-report.ts`:
   - Single Sonnet 4.6 call via `trackedLLMCall(client, params, "checkpoint-analysis")`
   - `zodOutputFormat(CheckpointReportSchema)`
   - Receives: rubric, whatever evidence is available (code, SonarQube metrics, harness logs, test results or their absence), and `evaluation_coverage` metadata
   - Produces: per-criterion gap analysis (`on-track`/`at-risk`/`not-started`/`blocked`), AI usage snapshot, top 3 priorities

4. Write `packages/grading/src/activities/store-checkpoint.ts`:
   - Insert into `checkpoints` table with `expires_at` = `now() + retention_days` (from cohort config)
   - `storeArtifact(cohortId, "checkpoints", checkpointId, ...)` — checkpoint report JSON, partial build logs
   - Emit `pipeline_usage_events` row with `pipeline_type: "checkpoint"`
   - If `--persist` flag was set (passed through submission metadata), set `expires_at` to null

5. Write checkpoint prompts in `packages/grading/src/prompts/`:
   - `checkpoint-analysis.txt` — single-pass prompt for Sonnet. Instructions:
     - Assess each rubric criterion as `on-track`, `at-risk`, `not-started`, or `blocked`
     - Provide indicative score only where evidence is sufficient (null otherwise)
     - Generate concrete, actionable recommendations (not generic advice)
     - Identify top 3 priorities for remaining time
     - Be encouraging but honest — formative feedback, not final judgment
   - `checkpoint-cached-prefix.txt` — shares the same `cohortId + weekNumber` cache key as the full grading pipeline

6. Write `packages/cli/src/commands/checkpoint.ts`:
   - Run soft audit (from Phase 4's `soft-audit.ts`) — failures are warnings, not blockers
   - Hard requirements: Git repo initialized, at least one source file, proxy config present
   - `git push` current state to GitLab
   - `POST /api/checkpoints` with current commit SHA
   - Poll `GET /api/status/:jobId` — Clack spinner, expected <90s
   - On completion, fetch and display checkpoint report:
     - Evaluation coverage summary (what could/couldn't be assessed)
     - Per-criterion gap status (color-coded: green/yellow/red/gray)
     - AI usage snapshot
     - Top 3 priorities
     - Disclaimer: *"These are indicative assessments based on your current progress. Final scores may differ."*
   - Flags: `--ci`, `--verbose`, `--persist`

7. Write `packages/api/src/jobs/checkpoint-cleanup.ts`:
   - Temporal scheduled workflow or cron, runs daily at 03:00 UTC
   - Delete expired checkpoint rows (`WHERE expires_at < now()`)
   - Delete corresponding submission rows of type `"checkpoint"` with no remaining checkpoint reference
   - Delete orphaned artifacts from `/data/cohorts/{id}/checkpoints/`
   - Log cleanup stats

8. Write tests:
   - `checkpoint-submission.test.ts` — verify workflow completes with all permutations of partial evidence (no Docker, no tests, no harness logs, combinations)
   - `generate-checkpoint-report.test.ts` — mock Sonnet via `trackedLLMCall`, verify schema validation, verify nullable fields when evidence is missing
   - `analyze-code-light.test.ts` — verify shared SonarQube helper, verify shorter prompt, verify single Sonnet call
   - `store-checkpoint.test.ts` — verify TTL calculation, verify `--persist` sets null expiry, verify usage event emitted
   - `checkpoint-cleanup.test.ts` — verify expired rows and artifacts are deleted, non-expired preserved
   - `checkpoint-scoping.test.ts` — student in cohort A cannot see cohort B checkpoints
   - `checkpoint-cli.test.ts` — verify soft audit, verify display output

**Files touched:** `packages/grading/src/workflows/checkpoint-submission.ts`, `packages/grading/src/activities/{analyze-code-light,generate-checkpoint-report,store-checkpoint}.ts`, `packages/grading/src/prompts/checkpoint-*.txt`, `packages/grading/src/activities/analyze-code.ts` (extract shared SonarQube helper), `packages/api/src/server.ts` (checkpoint routes), `packages/api/src/jobs/checkpoint-cleanup.ts`, `packages/cli/src/commands/checkpoint.ts`

**Validation:**
- `kiln checkpoint` with incomplete project (no Docker, no tests) → completes with report showing `docker_build: "skipped"`, `tests_run: "skipped"`, gap statuses reflect missing evidence
- `kiln checkpoint` with complete project → completes in <90s, all `evaluation_coverage` fields populated
- Checkpoint report validates against `CheckpointReportSchema` — zero Zod errors
- Checkpoint from cohort A not visible to cohort B student → 403 or 404
- Expired checkpoints cleaned up after TTL — row deleted, artifacts deleted
- `--persist` flag → checkpoint stored permanently, `expires_at` null
- SonarQube project cleaned up after checkpoint analysis — no orphaned `checkpoint-*` projects
- Prompt caching shared with full pipeline — checkpoint for same `(cohortId, weekNumber)` shows `cache_read_input_tokens > 0` if prefix already cached
- Checkpoint does NOT appear in `GET /api/results/:id` or grading analytics — no contamination
- Usage event emitted with `pipeline_type: "checkpoint"`, cost lower than grading (single Sonnet call vs multi-pass)

---

### Phase 7 — Usage & Cost Metrics

**Goal:** Implement the usage analytics system — daily rollups, admin API, anomaly detection, CLI drilldown, and CSV export — giving admins real-time visibility into pipeline spend and resource consumption.

**Steps:**

1. Create `packages/api/src/jobs/rollup-usage.ts`:
   - Temporal scheduled workflow, runs daily at 04:00 UTC
   - Aggregates previous day's `pipeline_usage_events` → `usage_daily_rollups`
   - Per `(cohortId, date, pipelineType)`: total runs, success/fail counts, unique students, token sums, cost sum, avg/p95 duration, avg artifact size
   - Evaluates alert conditions and inserts into `usage_alerts`:

   | Anomaly | Detection | Severity |
   |---------|-----------|----------|
   | Single student >3× cohort avg cost | `student_total_cost > 3 * cohort_avg_cost` | info |
   | Cache hit rate drops below 40% | Rolling 24h window | warning |
   | Pipeline failure rate >10% in 24h | Rolling count | critical |
   | Spend spike >2× daily average | Day-over-day comparison | warning |
   | Opus tokens in non-synthesis calls | `llm_calls` where `model = opus` and `purpose != pass3-synthesis` | critical |

2. Implement admin usage API routes (defined in Phase 5's server.ts, logic implemented here):
   - `GET /api/admin/usage/summary` — aggregate across cohorts. Supports `from`/`to` date range.
   - `GET /api/admin/usage/cohorts/:id` — per-cohort: daily spend curve, per-week totals, checkpoint vs grading split
   - `GET /api/admin/usage/cohorts/:id/students` — per-student sorted by total cost
   - `GET /api/admin/usage/cohorts/:id/weeks/:n` — per-week drilldown: pass-level cost breakdown, SonarQube/Docker times, cache efficiency, failure rate
   - `GET /api/admin/usage/alerts` — active alerts, filterable by severity and cohort
   - `GET /api/admin/usage/forecast` — trend extrapolation: rolling 7-day avg projected to end of billing period
   - `GET /api/admin/usage/export` — CSV export of raw events, date + cohort filtered
   - All routes require admin JWT. Non-admin → 403.

3. Create `packages/cli/src/commands/admin/usage.ts`:
   ```
   kiln admin usage                                # Global summary, current billing period
   kiln admin usage --cohort 2026-Q2               # Cohort-specific
   kiln admin usage --cohort 2026-Q2 --week 3      # Week drilldown
   kiln admin usage --students --cohort 2026-Q2    # Per-student table
   kiln admin usage --forecast                     # Spend projection
   kiln admin usage --alerts                       # Active alerts
   kiln admin usage --export --from 2026-04-01 --to 2026-04-12  # CSV export
   ```
   - Output uses Clack tables and formatted numbers
   - Cost in USD with 4 decimal places, tokens abbreviated (`1.2M input tokens`)
   - `--ci` outputs JSON
   - `--verbose` adds per-call detail

4. Write tests:
   - `rollup-usage.test.ts` — verify daily aggregation math (sums, counts, percentiles), verify alert triggers fire at correct thresholds
   - `usage-api.test.ts` — verify admin routes return correct data scoped by cohort, verify non-admin gets 403
   - `usage-export.test.ts` — verify CSV export format, date filtering, column schema
   - `usage-forecast.test.ts` — verify trend extrapolation logic
   - `usage-alerts.test.ts` — verify each anomaly detection rule fires correctly

**Files touched:** `packages/api/src/jobs/rollup-usage.ts`, `packages/api/src/routes/admin/usage.ts`, `packages/cli/src/commands/admin/usage.ts`, tests

**Validation:**
- Full grading pipeline run produces a `pipeline_usage_events` row with all LLM call details, durations, cost estimate
- Checkpoint run produces a row with `pipeline_type: "checkpoint"`, cost lower than grading
- `GET /api/admin/usage/summary` returns correct totals matching `SUM()` over raw events
- `GET /api/admin/usage/cohorts/:id/students` sorted by cost descending
- Daily rollup aggregates correctly — `total_runs` matches event count for that day+cohort+type
- Cache efficiency: `cache_read_tokens / (input_tokens + cache_read_tokens)` matches expected ratio
- Alert fires when failure rate >10% — insert 11 events (10 failed, 1 success), verify alert row created
- Non-admin → 403 on all `/api/admin/usage/*` endpoints
- `kiln admin usage --export` produces valid CSV with correct columns and row count
- Cost estimate within 10% of Anthropic dashboard (manual verification during T1 pre-flight)

---

### Phase 7.5 — Artifact Dispatch & Portal Integration

**Goal:** Implement the pluggable artifact dispatch subsystem as a child Temporal workflow, the admin CRUD + observability API, and the first concrete target (Kiln Portal) that generates tailored interview questions and triggers a video interview workflow from a one-sheet + AI usage snapshot.

**Steps:**

1. Apply `0005_dispatch.sql` migration — `dispatch_targets`, `dispatch_events` tables present, indexed on `(cohort_id, week_id)` and `(submission_id)` respectively.

2. Add Zod schemas to `packages/shared/src/schemas/dispatch.ts`:
   - `DispatchTargetSchema` — validates admin create/update payloads
   - `DispatchEventSchema` — mirrors `dispatch_events` row
   - `ArtifactSelectorSchema` — enum of `"one_sheet" | "logs_summary" | "sonar_metrics" | "ai_usage" | "raw_archive"`
   - `RetryPolicySchema` — `{ maxAttempts: number, backoffSeconds: number[] }`
   - `DispatchTriggerSchema` — enum `"final" | "checkpoint"`
   - Re-export from `@kiln/shared`

3. Create `packages/grading/src/workflows/dispatch-artifacts.ts` — child workflow:
   ```
   Input: { submissionId, cohortId, weekId, trigger: "final" | "checkpoint" }

   ① loadTargets(cohortId, weekId, trigger) → DispatchTarget[]
      (filter enabled=true, triggerOn includes trigger; week-scoped targets
       override cohort-wide targets with the same name)
   ② For each target: startChildWorkflow(dispatchSingleTarget, { target, submissionId })
      — run in parallel, each with its own retry/backoff
   ③ Wait all, log summary. Never throws.
   ```

4. Create `packages/grading/src/workflows/dispatch-single-target.ts`:
   ```
   Input: { target, submissionId, cohortId }

   ① buildPayload(submissionId, target.artifactSelectors) → payload
      — assembles selected artifacts from grading_results + storage
      — redacts any known secret patterns (sk-ant-*, glpat-*, bearer tokens)
      — if total > 2 MB, replaces raw_archive with signed URL reference
      — runs optional transformTemplate via safe JSONata evaluator
   ② For attempt in 1..maxAttempts:
        a. activity: httpPostWithAuth(target.url, target.authMode, secretRef, payload)
        b. record dispatch_event row with status/http_status/latency/attempt/payloadBytes
        c. on 2xx → status "success", return
        d. on 4xx (non-429) → status "failed", return (do not retry client errors)
        e. on 5xx/429/network → status "retrying", sleep backoffSeconds[attempt-1]
      End loop → status "dead_letter".
   ```

5. Create `packages/grading/src/activities/dispatch/`:
   - `load-targets.ts` — Drizzle query, strictly scoped by `cohort_id`, with week-scoped override resolution
   - `build-payload.ts` — artifact assembly from `grading_results` + `storeArtifact` reads + `pipeline_usage_events` for AI usage snapshot
   - `resolve-secret.ts` — reads `auth_secret_ref` from env / secret store; never returns secret in any log line
   - `redact-payload.ts` — regex sweep for known secret patterns
   - `http-post-with-auth.ts` — fetch with timeout (30s), bearer/HMAC auth assembly, returns `{ httpStatus, latencyMs, responseRef, error? }`
   - `record-dispatch-event.ts` — single-row upsert into `dispatch_events`

6. Create `packages/grading/src/dispatch/targets/portal.ts` — Portal-specific payload shaper:
   - Declares default selectors `["one_sheet", "ai_usage"]`
   - Declares default `transformTemplate` producing `{ student_id, submission_id, one_sheet, ai_usage, rubric_version }`
   - Extracts Portal `responseRef` from response body (`job_id` or `interview_id`)
   - Seed a default Portal target per cohort at admin bootstrap (admin opt-in via `POST /api/admin/cohorts/:id/dispatch/targets` with `name: "kiln-portal"`)

7. Implement admin dispatch routes in `packages/api/src/routes/admin/dispatch.ts` (declared in Phase 5 server.ts list, implemented here):
   - CRUD routes validate against `DispatchTargetSchema`
   - `POST .../test` — runs a synthetic payload through the same `dispatch-single-target` workflow (or activity path) without DB writes, returns `{ httpStatus, latencyMs, previewPayload }`
   - `POST .../redispatch` — looks up target + submission (enforce cohort scoping), starts a fresh child workflow
   - All routes require admin JWT scoped to the cohort

8. (Optional CLI) `packages/cli/src/commands/admin/dispatch/`:
   - `list.ts` — `kiln admin dispatch list --cohort <id>` — show targets + enabled state
   - `test.ts` — `kiln admin dispatch test <targetId>` — trigger synthetic test, print result
   - `events.ts` — `kiln admin dispatch events --cohort <id> --status dead_letter` — observability drilldown
   - Same `--ci` / `--verbose` conventions as `admin usage`

9. Write tests:
   - `dispatch-artifacts.test.ts` — grading `store-results` with `type: "final"` and `stage: "final"` starts child workflow; `stage: "early"` does NOT; `type: "checkpoint"` does NOT
   - `dispatch-single-target.test.ts` — retry behavior across `[200, 500, 500, 200]` sequences, dead-letter after exhaustion, no retry on 4xx
   - `build-payload.test.ts` — selector combinations, size cap behavior, secret redaction
   - `portal.test.ts` — payload shape matches Portal expectations, `responseRef` extracted
   - `dispatch-api.test.ts` — cohort scoping (cohort A admin cannot touch cohort B targets), JWT admin-only
   - `dispatch-isolation.test.ts` — dispatch activity failure does not fail the parent grading workflow (assert parent status `completed`, dispatch event `dead_letter`)
   - `dispatch-redispatch.test.ts` — creates a fresh attempt row, does not mutate prior events

10. Integration test (end-to-end): seed two cohorts each with a mock Portal target, run final-stage grading, assert both cohorts dispatched to their own configured URL and stored distinct `dispatch_events` rows; kill the mock Portal mid-retry and verify dead-letter path.

**Files touched:** `packages/api/drizzle/0005_dispatch.sql`, `packages/shared/src/schemas/dispatch.ts`, `packages/grading/src/workflows/dispatch-*.ts`, `packages/grading/src/activities/dispatch/**`, `packages/grading/src/dispatch/targets/portal.ts`, `packages/api/src/routes/admin/dispatch.ts`, `packages/api/src/server.ts` (route registration), `packages/cli/src/commands/admin/dispatch/**`, `packages/grading/src/activities/store-results.ts` (child workflow kickoff), tests.

**Validation:**
- `bunx drizzle-kit push` — `dispatch_targets`, `dispatch_events` present
- Final-stage grading run with one enabled Portal target → 1 `dispatch_events` row with `status: "success"`, `http_status: 200`, `responseRef` populated
- Early-stage grading run with same target present → zero new `dispatch_events` rows
- Checkpoint run with same target present → zero new `dispatch_events` rows
- Mock Portal returning 500×5 → 5 `dispatch_events` rows, last one `status: "dead_letter"`, grading workflow still `completed`
- Mock Portal returning 401 → 1 row `status: "failed"`, no retry (client error)
- Cohort A admin calling `GET /api/admin/dispatch/events?cohort_id=<B>` → 403
- `auth_secret_ref = "PORTAL_TOKEN_COHORT_A"` resolved at dispatch time; secret never appears in `dispatch_events.error`, workflow logs, or Temporal event history
- `POST /api/admin/dispatch/redispatch` creates a fresh attempt row, previous rows untouched
- Payload >2 MB — `raw_archive` replaced with signed URL reference, `payload_bytes` < cap

---

### Phase 8 — Regression Suite & Hardening

**Goal:** Add Vitest regression suite, finalize error handling, harden multi-cohort flows, checkpoint edge cases, and usage metric correctness.

**Steps:**

1. Create `packages/grading/test/regression/`:
   - `gold-set/` — 5-10 human-graded submissions with known scores. **Include submissions from at least 2 different cohort rubrics** to validate rubric-sensitivity.
   - `regression.test.ts`:
     ```typescript
     import { describe, it, expect } from "vitest";
     import { generateOneSheet } from "../../src/activities/generate-one-sheet";
     import goldSet from "./gold-set/index.json";

     describe("grading regression", () => {
       for (const submission of goldSet.submissions) {
         it(`${submission.id} (cohort: ${submission.cohortName}): within ±5`, async () => {
           const result = await generateOneSheet(
             submission.student_id,
             submission.week,
             submission.code_files,
             submission.normalized_logs,
             submission.video_transcript,
             submission.test_results,
             submission.rubric  // Cohort-specific rubric
           );

           expect(result.rubric_scores).toHaveLength(5);

           for (const criterion of result.rubric_scores) {
             const expected = submission.expected_scores[criterion.criterion];
             expect(criterion.awarded_points).toBeGreaterThanOrEqual(expected - 5);
             expect(criterion.awarded_points).toBeLessThanOrEqual(expected + 5);
           }

           for (const tp of result.talking_points) {
             expect(tp.citations.length).toBeGreaterThanOrEqual(1);
           }

           expect(result.ai_usage_analysis.tools_used.length).toBeGreaterThanOrEqual(1);
         }, { timeout: 120_000 });
       }
     });
     ```
2. Create regression Vitest project config
3. Update `.gitlab-ci.yml` — regression stage blocks merge on prompt/model/schema changes (already includes checkpoint files from Phase 1)
4. Create `gold-set/README.md` — how to add submissions, update scores, run locally
5. Create `gold-set/manifest.json` — maps each gold-set submission to `(cohortName, weekNumber, rubricVersion)` with grader names and date
6. **Harden `kiln submit`:** retry 3x, verify git push, clear errors with fix commands
7. **Harden `kiln checkpoint`:** graceful handling of API unreachable, Temporal timeout, partial evidence edge cases
8. **Harden `kiln audit`:** `--fix` for trivials, secret scan fails loudly
9. **Harden admin routes:** validate rubric YAML syntax on `POST /api/admin/cohorts/:id/weeks`, validate checkpoint config on `PATCH`
10. **Harden multi-cohort:** verify all queries (grading + checkpoint + usage + dispatch) join through `cohort_members` or `cohort_id` — no data leakage
11. **Harden usage metrics:**
    - Verify `trackedLLMCall()` gracefully handles SDK errors (still records what it can)
    - Verify rollup job is idempotent (re-running doesn't double-count)
    - Verify cost estimates don't drift if pricing table is stale (add `PRICING_LAST_UPDATED` check with warning)
12. Add CI check: flag checkpoint prompt files as "related" when grading prompts change in the same PR
13. Write integration tests:
    - Degrade prompt → regression fails → revert → passes
    - Two cohorts, different rubrics, concurrent grading + checkpoints → no interference, correct usage attribution
    - Checkpoint + grading for same student+week → prompt cache shared
    - Usage rollup after mixed batch (grading + checkpoint) → correct aggregation
14. Run full suite: `bunx turbo test`

**Files touched:** `packages/grading/test/regression/**`, `.gitlab-ci.yml`, CLI hardening, usage hardening

**Validation:**
- `bun test --filter regression` — all gold-set assertions pass (including multi-rubric submissions)
- Degrade prompt → regression fails
- `kiln submit` handles network failure gracefully
- `kiln checkpoint` handles API unreachable gracefully (retries, then clear error)
- `kiln audit` detects secrets in Docker layers
- Admin can create cohort, add weeks with different rubrics, bulk-add students, configure checkpoints
- All DB queries scoped by cohort — verified by test (grading, checkpoint, and usage queries)
- Usage rollup idempotent — running twice produces same results
- Cost estimate staleness warning fires if `PRICING_LAST_UPDATED` > 90 days old

---

## 5. Claude Code Workflow

```
INSPECT → PLAN → IMPLEMENT → VALIDATE → ITERATE
```

### INSPECT
- Read file before editing
- Check if file exists before creating
- Check `package.json` before adding deps (use `bun add`, not `npm install`)
- Read schema before modifying

### PLAN
- State change + reason in one sentence
- List files if >3 touched
- Justify new deps

### IMPLEMENT
- Small diffs — one logical change per edit
- Never rewrite entire files
- Import from `@kiln/shared` — never duplicate schemas
- Use `bun add <dep>` (not `npm install`, not `pnpm add`)
- Every function gets JSDoc, every command gets `static description` + `static examples`
- All LLM calls go through `trackedLLMCall()` — never call Anthropic SDK directly
- Extract shared logic (e.g., SonarQube scanning) into helpers rather than duplicating between grading and checkpoint activities

### VALIDATE
- After edit: `bunx turbo typecheck --filter=<pkg>`
- After feature: `bunx turbo test --filter=<pkg>`
- After dep change: `bun install && bunx turbo build`
- After CLI change: `kiln <cmd> --help`

### ITERATE
- Fix immediately on failure. Max 3 iterations. Stop and report after 3.

---

## 6. Execution Loop

```
PLAN → EXECUTE → VERIFY → REFLECT → ITERATE (max 3)
```

1. **PLAN:** Atomic task. Expected outcome.
2. **EXECUTE:** Small diff. Existing patterns.
3. **VERIFY:** typecheck + test + lint. CLI: `--help` + test input.
4. **REFLECT:** Pass → commit. Fail → diagnose.
5. **ITERATE:** Fix + re-verify. Max 3. Then stop + report.

---

## 7. Verification Strategy

| Phase | Command | Success |
|-------|---------|---------|
| 1 | `bun install` | `bun.lockb` created, workspace links resolved |
| 1 | `bunx turbo build` | All packages compile |
| 1 | `docker compose -f docker-compose.infra.yml up -d` | Temporal `:8080`, PG, Redis, SonarQube `:9000` |
| 2 | `kiln init --ci` | Config written with `cohortId` |
| 2 | `kiln scaffold --week 1 --no-docker --no-proxy` | Dir tree with cohort-specific rubric |
| 3 | `docker compose build kiln-proxy` | Image from source, <10MB |
| 3 | `curl localhost:9100/healthz` | `{"status":"ok"}` |
| 4 | `kiln chaos --verify` | Verdict in output |
| 4 | `kiln audit` (valid/invalid) | Correct exit codes + fix commands |
| 5 | `bunx drizzle-kit push` | All tables including checkpoints, usage tables |
| 5 | SonarQube scan on sample | Metrics returned via API |
| 5 | Temporal grading workflow | 7 steps complete, ④∥②③, cohort rubric used, usage event emitted |
| 5 | Cross-cohort test | Student A (cohort 1) cannot see cohort 2 results |
| 6 | `kiln checkpoint` (incomplete project) | Report with partial coverage, <90s |
| 6 | `kiln checkpoint` (complete project) | Full report, <90s |
| 6 | Checkpoint expiry | Cleaned up after TTL |
| 6 | Checkpoint isolation | Cohort A cannot see cohort B checkpoints |
| 7 | `GET /api/admin/usage/summary` | Correct cost totals |
| 7 | `kiln admin usage --cohort X` | Per-cohort breakdown displayed |
| 7 | Usage alert | Fires on configured threshold |
| 7.5 | Final-stage grading with Portal target | `dispatch_events` row `status=success`, Portal `responseRef` stored |
| 7.5 | Mock Portal 500×N | Retries per policy, dead-letter on exhaustion, grading still `completed` |
| 7.5 | Early or checkpoint run | Zero dispatch events generated |
| 7.5 | Cross-cohort dispatch admin call | 403 |
| 8 | `bun test --filter regression` | Gold set passes (multi-rubric) |

### Early Failure Detection

- `bun install` fails → check workspace declarations in root `package.json`
- `bunx turbo build` fails → schema or import error
- SonarQube scanner fails → check project exists, token valid, scanner CLI installed in grading worker
- Cross-cohort leak → missing `WHERE cohort_id =` in query. Audit every Drizzle query (grading, checkpoint, AND usage).
- Prompt caching miss → verify cache key includes `cohortId + weekNumber`
- Checkpoint >90s → profile: is SonarQube the bottleneck? Is the Sonnet prompt too long?
- Usage cost estimate off by >10% → check `pricing.ts` rates against current Anthropic pricing page
- Rollup double-counting → verify idempotency guard in `rollup-usage.ts`
- Dispatch stuck "pending" → parent workflow closed before child started; verify `ParentClosePolicy.ABANDON` on child start
- Dispatch retry storm → verify 4xx short-circuits and `maxAttempts` is enforced
- Portal secret in logs → verify `redact-payload.ts` regex covers bearer tokens and `resolve-secret.ts` never returns the secret into any log sink

---

## 8. Guardrails

### DO

- ✅ Use `bun install`, `bun add`, `bun test`, `bunx` — never pnpm/npm/yarn
- ✅ Read files before editing
- ✅ One logical change per commit
- ✅ Run typecheck + test after every change
- ✅ Import shared types from `@kiln/shared`
- ✅ Use `zodOutputFormat()` for ALL LLM calls (grading AND checkpoint)
- ✅ Use `trackedLLMCall()` for ALL Anthropic SDK calls — never call SDK directly
- ✅ Use Clack prompts for ALL interactive CLI output
- ✅ Include `--ci` and `--verbose` on every command
- ✅ Every error includes a fix command
- ✅ Every Temporal activity is idempotent and resumable
- ✅ Proxy hot path is fully async
- ✅ Prompt caching key = `cohortId + weekNumber` (shared between grading and checkpoint pipelines)
- ✅ All DB queries scoped by cohort — join through `cohort_members` or `weeks`
- ✅ Validate citations post-generation
- ✅ Clean up SonarQube projects after analysis (DELETE via API) — both grading and checkpoint
- ✅ Pass rubric as workflow input — never hardcode rubric content
- ✅ Use filesystem storage (Fly Volume)
- ✅ Build proxy from source
- ✅ Use GitLab — verify `X-Gitlab-Token`
- ✅ Clearly label all checkpoint output as formative, not final
- ✅ Reuse SonarQube scanning logic — extract to shared helper, don't duplicate
- ✅ Store checkpoint artifacts in separate path (`/checkpoints/` not `/submissions/`)
- ✅ Run checkpoint cleanup job daily
- ✅ Record token usage and cost per pipeline run in `pipeline_usage_events`
- ✅ Emit usage events for both grading and checkpoint pipelines
- ✅ Operate `kiln scaffold` on existing repos via `--adopt` (or auto-detect a non-empty Git repo) — install `.kiln/` without touching user source files
- ✅ Scan project manifests (`package.json`, `requirements.txt`, `pyproject.toml`, `go.mod`, `Cargo.toml`, `Gemfile`) in `init`, `doctor`, `scaffold`, and `audit` — surface missing host toolchains with fix commands
- ✅ Hard-fail `kiln audit` when `Dockerfile`/`docker-compose.yml` is missing or `docker compose build` fails
- ✅ In `build-docker` grading activity, treat missing/broken Dockerfile as a scored rubric failure (Ships = 0 with reason) — not a Temporal activity crash
- ✅ Share the manifest-scanner helper (`lib/runtime-discovery.ts`) between CLI commands — do not duplicate per command
- ✅ Keep the hidden chaos profile server-side only — load from `weeks.hidden_chaos_yaml`, pass into workflow input, never echo back in any student-scoped API response
- ✅ Hidden profile must share fault categories and steady-state criteria with the visible profile — only target/timing/intensity permutations may differ
- ✅ Score the Resilience axis primarily from hidden-set results on `stage: "final"` runs
- ✅ Default `kiln submit` stage to `final`; require explicit `--stage early` for dress rehearsals
- ✅ Run artifact dispatch as a child Temporal workflow with `ParentClosePolicy.ABANDON`
- ✅ Scope every dispatch query (targets, events) by `cohort_id`
- ✅ Redact known secret patterns from every dispatch payload before POST
- ✅ Resolve dispatch secrets via `auth_secret_ref` at call time — never persist inline
- ✅ Record every dispatch attempt in `dispatch_events` with status, http_status, latency, payload_bytes

### DO NOT

- ❌ Do NOT use pnpm, npm, or yarn — Bun only
- ❌ Do NOT rewrite entire files
- ❌ Do NOT duplicate Zod schemas
- ❌ Do NOT hardcode model IDs — configurable routing
- ❌ Do NOT use Plop.js or Handlebars
- ❌ Do NOT buffer full LLM responses in proxy
- ❌ Do NOT use sync writes in proxy capture
- ❌ Do NOT skip audit before submit (but DO allow soft audit for checkpoint)
- ❌ Do NOT hardcode rubric content in prompts — inject per cohort+week
- ❌ Do NOT allow cross-cohort data access — every query must scope
- ❌ Do NOT leave SonarQube projects after analysis — always clean up
- ❌ Do NOT add S3/R2 — filesystem storage
- ❌ Do NOT reference GitHub — GitLab only
- ❌ Do NOT add PromptFoo — Vitest regression
- ❌ Do NOT create Next.js dashboard (out of scope)
- ❌ Do NOT use BullMQ as primary orchestrator — Temporal owns workflows
- ❌ Do NOT record checkpoint scores in `grading_results` — separate table
- ❌ Do NOT include checkpoints in cohort grading analytics or score distributions
- ❌ Do NOT allow grader overrides on checkpoints
- ❌ Do NOT require a passing audit for checkpoints — defeats the purpose
- ❌ Do NOT run the full 3-pass one-sheet generation for checkpoints — single pass only
- ❌ Do NOT use Opus for checkpoints — Sonnet only (cost control)
- ❌ Do NOT call Anthropic SDK directly — always use `trackedLLMCall()`
- ❌ Do NOT overwrite an existing `Dockerfile`, `Containerfile`, `docker-compose.yml`, or `compose.yaml` during `kiln scaffold` — skip with `skipped (exists)` message unless `--force` is passed
- ❌ Do NOT clobber existing source files, `package.json`, or `.env` in brownfield mode — `.env` is merged, everything else is `skip-if-exists`
- ❌ Do NOT let `kiln audit` pass without a buildable `Dockerfile` + `docker-compose.yml` — it is a hard gate for `kiln submit`
- ❌ Do NOT crash the grading workflow on a missing/broken Dockerfile — return a graded failure from `build-docker` so the student still gets a one-sheet
- ❌ Do NOT assume the project runtime — always discover it from manifests; never hardcode Node/TS assumptions in generic checks
- ❌ Do NOT ship the hidden chaos profile in the scaffold, the student repo, API responses, CLI output, or log lines
- ❌ Do NOT run the hidden chaos set during `kiln checkpoint` or `kiln submit --stage early` — hidden set runs ONLY on `stage: "final"` grading runs
- ❌ Do NOT allow the hidden profile to diverge from the visible profile in fault category or steady-state criteria — only permutations may differ
- ❌ Do NOT score the Resilience axis from visible-set results alone on final submissions — must be primarily hidden-set driven
- ❌ Do NOT block or fail the grading pipeline on dispatch errors — dispatch is fire-and-observe
- ❌ Do NOT dispatch artifacts from checkpoint pipelines or early submissions unless a target explicitly opts in via `trigger_on`
- ❌ Do NOT POST full raw archives inline — exceed 2 MB → signed URL reference
- ❌ Do NOT store dispatch `auth_secret` values in the database — only `auth_secret_ref`
- ❌ Do NOT log resolved secrets or `Authorization` headers anywhere (workflow history, dispatch_events.error, app logs)
- ❌ Do NOT share dispatch targets across cohorts — every target is cohort-scoped

---

## 9. Submission Checklist

### Monorepo & Tooling
- [ ] `bun install` — `bun.lockb` exists, no other lockfiles
- [ ] `bunx turbo build` — all packages compile
- [ ] `bunx turbo typecheck` — zero errors
- [ ] `bunx turbo lint` — zero Biome violations
- [ ] `bunx turbo test` — all unit tests pass
- [ ] `bun test --filter regression` — gold-set passes (multi-rubric)
- [ ] GitLab CI pipeline green
- [ ] Infrastructure compose: Temporal, PG, Redis, SonarQube all healthy

### CLI Commands
- [ ] `kiln init` — validates env, writes config with cohort info
- [ ] `kiln scaffold --week N` — generates project with cohort-specific rubric (greenfield)
- [ ] `kiln scaffold --week N --adopt` — installs `.kiln/` into an existing repo without overwriting Dockerfile/compose/source
- [ ] `kiln scaffold` detects declared runtimes and reports missing host toolchains
- [ ] `kiln proxy start/stop/status`
- [ ] `kiln chaos latency/kill/stress/disconnect` + `--verify`
- [ ] `kiln chaos profile week-XX`
- [ ] `kiln audit` / `kiln audit -v` / `kiln audit --fix`
- [ ] `kiln logs analyze`
- [ ] `kiln checkpoint` / `kiln checkpoint --persist` / `kiln checkpoint --verbose`
- [ ] `kiln submit --stage early` → `kiln status` → `kiln results` (dress rehearsal, no hidden chaos)
- [ ] `kiln submit --stage final` → `kiln status` → `kiln results` (graded run, includes hidden chaos)
- [ ] `kiln doctor` (shows cohort info, detected runtimes, Dockerfile-presence warning)
- [ ] `kiln config set/get/list`
- [ ] `kiln admin usage` (all subflags: `--cohort`, `--week`, `--students`, `--forecast`, `--alerts`, `--export`)
- [ ] All commands: `--ci`, `--verbose`, tab completion

### Proxy
- [ ] Builds from source, <10MB, no registry
- [ ] SSE pass-through, <5ms latency
- [ ] JSONL matches schema
- [ ] Ring buffer overflow graceful
- [ ] `kiln.chaos.exclude` respected

### Multi-Cohort
- [ ] Create cohort with 100 students — no performance degradation
- [ ] Two cohorts with different rubrics for same week number — correct rubrics applied
- [ ] Student in cohort A cannot access cohort B data via any API endpoint (grading, checkpoints, usage)
- [ ] Grader in both cohorts sees both — scoped per-cohort
- [ ] Admin creates weeks, rubrics, project configs per cohort
- [ ] Admin configures checkpoint settings per cohort
- [ ] Prompt caching isolated by cohort+week — no cross-cohort cache pollution
- [ ] Artifacts stored under `/data/cohorts/{cohortId}/submissions/{id}/` and `/data/cohorts/{cohortId}/checkpoints/{id}/`

### Grading Pipeline
- [ ] SonarQube scanner runs, metrics returned, project cleaned up
- [ ] LLM code analysis prompt includes SonarQube metrics as evidence
- [ ] All LLM calls go through `trackedLLMCall()` — usage details accumulated
- [ ] Temporal workflow: 7 steps, ④∥②③
- [ ] `zodOutputFormat()` on all LLM calls
- [ ] One-sheet validates against schema
- [ ] Prompt caching verified (token counts)
- [ ] Citations validated post-generation
- [ ] `rubric_version`, `prompt_version`, `model_version` recorded
- [ ] Pipeline <3 min
- [ ] GitLab webhook triggers pipeline
- [ ] Usage event emitted on completion
- [ ] `build-docker` activity on missing Dockerfile → grading workflow completes, Ships scored 0 with reason in one-sheet
- [ ] `build-docker` activity on build failure → grading workflow completes with captured build-log tail in one-sheet
- [ ] `kiln audit` hard-fails without buildable `Dockerfile` + `docker-compose.yml`
- [ ] `kiln audit` hard-fails when a declared runtime toolchain is missing/below min version
- [ ] `stage: "early"` run completes with full one-sheet minus hidden chaos; Resilience axis marked `"dress_rehearsal"`
- [ ] `stage: "final"` run executes visible + hidden chaos sets, both results labeled in test output
- [ ] Hidden chaos YAML not present in any student-scoped API response (verified by grep of HTTP logs during integration test)
- [ ] Admin can upload hidden profile via `PATCH /api/admin/cohorts/:id/weeks/:n/hidden-chaos`

### Checkpoint System
- [ ] `kiln checkpoint` with incomplete project → completes with partial `evaluation_coverage`
- [ ] `kiln checkpoint` with complete project → <90s
- [ ] Report validates against `CheckpointReportSchema`
- [ ] Checkpoint NOT visible in `GET /api/results/:id` or grading analytics
- [ ] Checkpoint scoped by cohort — cross-cohort access blocked
- [ ] Expired checkpoints cleaned up (rows + artifacts)
- [ ] `--persist` flag works (null expiry)
- [ ] SonarQube project cleaned up after checkpoint
- [ ] Prompt caching shared with grading pipeline
- [ ] Checkpoint uses Sonnet only (no Opus) — verified in usage event
- [ ] Usage event emitted with `pipeline_type: "checkpoint"`

### Usage & Cost Metrics
- [ ] Every pipeline run (grading + checkpoint) produces a `pipeline_usage_events` row
- [ ] Row includes all LLM call details with `purpose` tags
- [ ] Cost estimate within 10% of actual (manual verification)
- [ ] Daily rollup runs, aggregates correctly, is idempotent
- [ ] Admin usage API routes return correct data, scoped by cohort
- [ ] Non-admin gets 403 on usage endpoints
- [ ] Anomaly alerts fire at configured thresholds
- [ ] `kiln admin usage --export` produces valid CSV
- [ ] Forecast extrapolation produces reasonable projections
- [ ] `PRICING_LAST_UPDATED` within 90 days of deployment

### Artifact Dispatch
- [ ] `dispatch_targets` + `dispatch_events` tables present after `0005_dispatch.sql`
- [ ] Admin can CRUD targets via `/api/admin/...dispatch/targets`
- [ ] Final-stage grading run triggers child `dispatch-artifacts` workflow; checkpoint and early runs do not
- [ ] Portal target POSTs one-sheet + AI usage with bearer auth, stores Portal `responseRef`
- [ ] Retries follow `retry_policy` with exponential backoff; dead-letter on exhaustion
- [ ] Dispatch failure leaves grading workflow `completed` and results visible
- [ ] Secrets resolved from `auth_secret_ref`, never logged, never persisted inline
- [ ] Cross-cohort admin access blocked (403)
- [ ] `POST /api/admin/dispatch/redispatch` creates a fresh attempt row
- [ ] Payload >2 MB replaces raw archives with signed URL references

### Error Handling
- [ ] Every CLI error includes fix command
- [ ] Network failures: retry + `kiln doctor`
- [ ] Auth failures: `kiln init --reset`
- [ ] Secret detection: fails loudly
- [ ] Temporal activities idempotent + resumable
- [ ] Checkpoint handles partial evidence gracefully (no crash)
- [ ] `trackedLLMCall()` handles SDK errors gracefully

---

## 10. Self-Evaluation

### Correctness
- Does proxy add <5ms? Profile under load.
- Does SonarQube + LLM hybrid produce better scores than LLM-only? Compare on gold set — SonarQube metrics should reduce variance on Code Craft scores.
- Are two cohorts with different rubrics getting different scores for identical code? They should — the rubric drives the evaluation.
- Does prompt caching work per-cohort? If cohort A and B have different rubrics, they must NOT share a cached prefix.
- Do checkpoints and grading share the same cache prefix for the same (cohortId, weekNumber)? They should — verify `cache_read_input_tokens > 0` on a checkpoint following a grading run.
- Are SonarQube projects cleaned up? Check SonarQube dashboard after a batch run — no orphaned projects (including `checkpoint-*` keys).
- Do checkpoint indicative scores diverge from final scores? They can — checkpoints use single-pass evaluation on potentially incomplete work. This is expected and acceptable.
- Is the cost estimate accurate? Compare `total_estimated_cost_usd` against the Anthropic dashboard for a batch. Target <10% deviation.
- Is the rollup idempotent? Run it twice for the same day — totals should not change.
- Does the hidden chaos set actually detect overfitting? Compare visible-set pass rate to hidden-set pass rate across a batch — a large gap (e.g. >20 pts) on individual submissions indicates the student overfit to visible tests. Spot-check at least 3 submissions per cohort per week.
- Is the hidden profile truly unseen? Grep every student-facing API response, scaffold output, and CLI log for any substring from `weeks.hidden_chaos_yaml`. Zero hits required.
- Does the early submission dress rehearsal materially change student behavior? Track: what fraction of students who submit early then improve their final-submission score? Target: >60%.

### Completeness
- All 12+ CLI commands with flags, examples, error messages?
- All 5 grading criteria evaluated in both grading and checkpoint pipelines?
- Multi-cohort: admin can create cohorts, weeks, rubrics, add students/graders, configure checkpoints?
- Scaffold templates for weeks 1-4?
- `kiln audit` checks all required files?
- Regression suite covers ≥2 different rubrics?
- Usage metrics cover both grading and checkpoint pipeline types?
- Admin can view usage by cohort, student, week, pipeline type?
- Anomaly detection covers all 5 alert types?
- Dispatch subsystem covers: admin CRUD, child workflow kickoff on final-stage only, Portal target, retries + dead-letter, secret redaction, cross-cohort isolation, observability via `dispatch_events`?

### Risks

| Risk | Mitigation |
|------|------------|
| **SonarQube as bottleneck** | Each grading + checkpoint run creates/deletes a SonarQube project. At 100 students × batch + checkpoints, SonarQube may queue. Mitigate: use ephemeral project keys, delete immediately after metric fetch, consider SonarQube project pool. |
| **SonarQube cold start** | First scan for a language downloads analyzers. Mitigate: pre-warm SonarQube by scanning a sample project for each expected language at infrastructure startup. |
| **LLM cost at scale** | 100 students × multiple cohorts × 3 passes + checkpoints. Mitigate: prompt caching (per cohort+week, shared between grading and checkpoints), batch API, Sonnet for passes 1-2 and all checkpoints (reserve Opus for pass 3 only). Usage metrics make cost visible so admins can react. |
| **Cross-cohort data leakage** | One missed `WHERE cohort_id =` breaks isolation. Now applies to grading, checkpoint, AND usage queries. Mitigate: Drizzle query wrapper that injects cohort filter, integration tests that verify isolation across all three domains. |
| **Students treat checkpoint scores as final** | Checkpoint output explicitly labeled `"type": "checkpoint"`. CLI includes disclaimer. Indicative scores are nullable where evidence is insufficient. |
| **Checkpoint load spikes before deadlines** | Checkpoints are lighter than full grading (<90s, single Sonnet). Temporal task queue priority can deprioritize checkpoints behind final submissions. Admin can disable checkpoints per cohort via `PATCH /api/admin/cohorts/:id/checkpoint-config`. Usage dashboards surface spikes in real time. |
| **Checkpoint prompts drift from grading prompts** | Shared cached prefix ensures rubric alignment. CI check flags checkpoint prompt files when grading prompts change. |
| **Rubric drift across cohorts** | Same concept, different rubrics → inconsistent grading. Mitigate: regression suite includes multi-rubric samples, admin tools for rubric diffing. |
| **Cost estimate staleness** | Anthropic updates pricing; `pricing.ts` becomes stale. Mitigate: `PRICING_LAST_UPDATED` constant, warning if >90 days old, manual verification against dashboard during T1 pre-flight. |
| **Usage rollup double-counting** | Rollup job re-runs after failure. Mitigate: idempotency guard — unique constraint on `(cohortId, date, pipelineType)`, upsert on conflict. |
| **Fly Volume durability** | Single-disk. Mitigate: periodic backup. Acceptable for MVP. |
| **Go proxy maintenance** | Separate language. Mitigate: <500 LOC, stable surface, comprehensive tests. |
| **Brownfield repo has no Dockerfile at submit time** | Grader cannot `docker compose build`. Mitigate: `kiln audit` hard-fails on missing Dockerfile; `kiln doctor` and `kiln scaffold --adopt` both surface the gap early; setup guide includes an "Adding a Dockerfile" section; `build-docker` grading activity handles the case as a scored rubric failure rather than a crash. |
| **Brownfield repo has a conflicting `docker-compose.yml`** | Student's existing compose file doesn't include the Kiln proxy. Mitigate: `kiln scaffold --adopt` never overwrites the existing file; prints a `skipped (exists)` warning and points the student at the template under `.kiln/templates/docker-compose.yml` to merge the `kiln-proxy` service manually. `kiln audit` verifies proxy capture integrity regardless of compose layout. |
| **Unknown / exotic project runtime** | Student uses a runtime Kiln doesn't recognize (e.g. Elixir, Deno). Mitigate: manifest scanner emits a `runtime: unknown` warning instead of failing; `kiln audit` still runs Docker build as the source of truth, and Dockerfile buildability is the backstop. |
| **Host toolchain mismatch** | Student's host Python is 3.9 but `pyproject.toml` requires 3.12 — dev-loop broken even though Docker build works. Mitigate: `init` and `doctor` surface this up front with a fix command (`mise install`, `pyenv install`, `brew install`); `audit` fails loudly if the host cannot run the project's declared runtime. |
| **Students overfit to visible chaos profile** | Students iterate locally against `.kiln/chaos-profiles/week-XX.yml` and may hard-code around exact targets/timings. Mitigate: hidden chaos set runs only on final submission with different permutations; Resilience axis is scored primarily from hidden-set results; self-eval compares visible vs hidden pass rates to detect overfit patterns; prompts explicitly down-weight visible-set results on final runs. |
| **Hidden profile drifts from visible profile** | If admin uploads a hidden profile that tests different fault categories than the visible profile, grading becomes unfair (students had no way to prepare). Mitigate: `PATCH /api/admin/cohorts/:id/weeks/:n/hidden-chaos` validates category + steady-state parity; CI check on cohort config repo; self-eval step confirms parity before each cohort kickoff. |
| **Hidden profile leakage** | One `console.log`, one API response, one scaffold bug, and the hidden set is public. Mitigate: server-side storage only, integration test greps all student-scoped responses for hidden YAML substrings, admin route is the only write path, never log hidden profile contents. |
| **Early submission treated as final** | Students may assume early submission score is their grade. Mitigate: one-sheet explicitly marks Resilience as `"dress_rehearsal"` on early runs, CLI output carries a disclaimer, docs emphasize that hidden chaos can move the Resilience score significantly. |
| **Dispatch endpoint outage (e.g. Portal down)** | Grading continues unaffected; dispatch retries with exponential backoff; dead-letters on exhaustion for admin replay via `POST /api/admin/dispatch/redispatch`. |
| **PII / secrets in dispatch payload** | Regex redaction sweep before POST (covers `sk-ant-*`, `sk-*`, `glpat-*`, bearer tokens); selectors explicitly enumerate what is sent; raw_archive capped at 2 MB with signed URL fallback. |
| **Retry storm overwhelms downstream** | Per-target `retry_policy` caps `maxAttempts`; 4xx client errors short-circuit; parallel dispatch across targets is bounded by `dispatch_targets` rows per cohort+week. |
| **Dispatch child workflow orphaned** | `ParentClosePolicy.ABANDON` on child start — parent grading can close without cancelling in-flight dispatch. Admin `GET /api/admin/dispatch/events?status=pending` surfaces stuck attempts. |
