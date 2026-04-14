# Kiln — Executive One-Sheet

**A CLI-first platform that grades how developers actually work with AI, not just what they ship.**

---

## The Problem

Today, graders work from a video walkthrough and a repo that may or may not run on their machine. There are no AI interaction logs, no captured test results, no structured metrics — just what the student chose to show on camera. Feedback goes into a plain textarea with no rubric structure, no evidence citations, and no consistency guarantees across graders. The result is slow, subjective, and hard to defend. Graders spend more time fighting environment setup than actually evaluating work, and students get feedback that varies wildly depending on who reviewed them.

The question we need to answer — *can this person ship reliable software with AI tools under real conditions?* — requires evidence we aren't currently collecting.

## What Kiln Does

Kiln captures the full execution trail — prompts, tool usage, system behavior under failure, test outcomes, and code quality — then synthesizes it into a structured assessment. The output explains not just what a student shipped, but how they reasoned, where they struggled, and whether they demonstrated production-ready judgment.

Students work in their own repos and local environments. Kiln captures evidence in the background and grades asynchronously. No dashboard to learn, no workflow to change.

Beyond final grading, Kiln provides **mid-project checkpoints** — student-initiated formative feedback that runs the same rubric against work-in-progress and returns actionable gap analysis in under 90 seconds. Students get directional guidance while there's still time to course-correct, without waiting for final results.

An integrated **usage and cost metrics system** gives admins real-time visibility into pipeline spend, token consumption, and cache efficiency across cohorts — making operational cost a managed input rather than a surprise.

## The Strategic Bet

**CLI-first, cohort-aware grading system — not a dashboard-first education product.**

This keeps the product aligned with how real developers work, reduces surface area, lowers operational overhead, and gets to a usable MVP faster. A web dashboard is intentionally deferred because it doesn't improve the core assessment signal in v1.

---

## How It Works

1. Student initializes Kiln locally and scaffolds the weekly project
2. A lightweight reverse proxy silently captures all LLM interactions as they work
3. At any point, the student can request a **checkpoint** — a fast, formative assessment of current progress against the rubric
4. When ready, the student submits through the CLI — Kiln validates the submission and triggers full grading
5. The grading pipeline clones the repo, builds/tests, normalizes logs, runs SonarQube and LLM code analysis, and generates a final one-sheet
6. That one-sheet becomes the primary assessment artifact
7. Every pipeline run — grading or checkpoint — emits usage metrics for admin visibility

## What the One-Sheet Contains

The output isn't just a score. It's a decision-support artifact covering how the student used AI, whether the system held up under failure conditions, code quality metrics (backed by SonarQube static analysis), where the student showed judgment, and where they need coaching. That makes Kiln useful beyond education — for hiring screens, internal upskilling, apprenticeships, and manager reviews.

## What a Checkpoint Contains

Checkpoint reports are distinct from one-sheets. They provide a per-criterion gap status (on-track, at-risk, not-started, or blocked), an AI usage snapshot, and a prioritized list of what to focus on next. Indicative scores are included where evidence is sufficient but are clearly labeled as formative — they don't count toward final results.

---

## Key Architecture Decisions

**Bun workspaces + Turborepo** — Bun is already the runtime and compiler, so using it for package management eliminates an entire tooling layer. Turborepo adds build orchestration without complicating things.

**Capture proxy for AI interaction logs** — AI-assisted development can't be graded credibly if the AI trail is invisible. The proxy makes the process observable without changing how students work. This is Kiln's strongest differentiator.

**SonarQube + Claude hybrid grading** — Static analysis alone misses architectural nuance. LLM review alone is too variable. SonarQube supplies hard metrics (complexity, duplication, coverage); Claude interprets those alongside source code and rubric criteria. Rigor meets judgment. A `trackedLLMCall()` wrapper instruments every Anthropic API call for token counting, cost estimation, and cache stats without changing LLM logic.

**Student-initiated checkpoints** — A reduced Temporal workflow that skips the full 3-pass synthesis and uses best-effort build/test. If Docker won't build or tests won't run, the checkpoint still analyzes whatever code and logs exist and reports what it couldn't evaluate. Checkpoints share the same prompt cache as grading (keyed by cohort + week), keeping marginal cost low.

**Per-pipeline usage tracking** — Every pipeline run records token counts, cost estimates, cache efficiency, and infrastructure durations. Daily rollups keep dashboard queries fast. Anomaly detection flags cost spikes, cache degradation, and failure rate increases. Admins manage spend through visibility rather than hard caps.

**Chaos engineering built into the student workflow** — Pumba and Toxiproxy enable CLI-driven fault injection (latency, kill, stress, disconnect) with automated steady-state verification. This lets Kiln assess resilience as a graded criterion, not just a nice-to-have.

**Temporal for workflow orchestration** — Both grading and checkpoint pipelines are multi-step and failure-prone. Temporal gives durability, retries, and resumability. Checkpoint workflows are lighter (single Sonnet pass, best-effort build) but benefit from the same orchestration guarantees.

**PostgreSQL + Fly Volume storage** — Postgres for structured data, filesystem for artifacts. Grading and checkpoint artifacts are stored in separate paths under cohort-scoped directories. No S3 abstraction needed on day one.

**GitLab as the backbone** — Repos, CI, registry, and webhooks in one platform. Fewer integration points, simpler onboarding, and cohort groups map naturally to the multi-tenant model.

**Multi-cohort isolation from day one** — Different cohorts need different projects, rubrics, graders, and schedules. Building this into the data model early prevents painful redesign and reduces leakage risk. Isolation applies to grading results, checkpoints, and usage metrics alike.

**Vitest gold-set regression suite** — Grading output must stay stable as prompts, models, and rubrics evolve. A regression suite against known-graded submissions (spanning multiple cohort rubrics) gives a direct way to measure drift and block bad changes.

---

## MVP Boundaries

**Included in v1:** CLI with 12+ commands, capture proxy, full grading pipeline, checkpoint system, usage and cost metrics with admin API, chaos engineering, multi-cohort data model, SonarQube hybrid analysis, regression suite.

**Intentionally excluded from v1:** full web dashboard, grader override web UI, plagiarism detection, adaptive rubrics, video analysis beyond transcripts, Langfuse integration, auto-triggered checkpoints, checkpoint diffing, and budget caps with enforcement.

The first release proves one thing: that Kiln can reliably generate a high-trust developer assessment using modern AI workflows, with formative feedback along the way and cost transparency for operators. Anything that doesn't improve that proof is postponed.

---

## Risks and Mitigations

| Risk | Mitigation |
|------|------------|
| LLM grading feels subjective | Paired with deterministic SonarQube metrics and test signals; structured Zod schemas; regression-tested outputs across multiple rubrics |
| Multi-step pipelines become fragile | Temporal handles retries, durability, and resumability by design — for both grading and checkpoint workflows |
| Cohort data leakage undermines trust | Data model and all queries (grading, checkpoints, usage) scoped by cohort from the start |
| Infrastructure complexity slows delivery | Stack constrained to three vendors (Anthropic, Fly.io, GitLab); unnecessary systems deferred |
| Prompt or model changes cause scoring drift | Gold-set regression suite gates all changes; prompt versions tracked; suite spans multiple rubrics |
| Students treat checkpoint scores as final | Checkpoint output explicitly labeled as formative; indicative scores are nullable; CLI includes disclaimer |
| LLM cost grows unpredictably at scale | Per-pipeline usage tracking with daily rollups; prompt caching shared across grading and checkpoints; Sonnet for all passes except final synthesis; admin dashboards surface spend in real time |
| SonarQube becomes a bottleneck at batch scale | Ephemeral project keys with immediate cleanup after analysis; pre-warmed language analyzers |
| Checkpoint load spikes before deadlines | Checkpoints are lightweight (<90s, single Sonnet call); Temporal task queue can deprioritize behind final submissions; admins can disable per cohort |

---

## Takeaway

Kiln's core bet is that the most valuable signal isn't the final code artifact — it's the full chain of execution: environment setup, AI usage, code quality, resilience, and reasoning under pressure. Every architecture choice serves that outcome by reducing unnecessary complexity, preserving flexibility across cohorts, maximizing the credibility of the assessment, and giving both students and operators the feedback loops they need — formative checkpoints for learners, cost visibility for admins.
