# KilnAI — Pre-Setup Guide

*Read this before Monday of Week 1. Budget 90 minutes.*

---

## Welcome to the Remote Phase

The remote phase is not onboarding. It is the first filter.

Every week you will ship a working product — not a demo, not a tutorial exercise, not a proof of concept. You will build three products over three weeks, and each one extends the previous week's codebase. By Friday of Week 3, you will have a multi-agent production system with grounded retrieval, human-in-the-loop approval, and full observability. One repo. Three products. The first three versions of a company.

This guide covers two things: what the program expects from you, and how to set up the tooling that makes it work.

---

## What You Are Building

| Week | Product | What It Proves |
|------|---------|----------------|
| 1 | **Questionnaire Forge** — AI-powered security questionnaire responder | You can make AI write software grounded in real documents |
| 2 | **FieldManual AI** — Grounded troubleshooting assistant for field technicians | You can ground AI decisions in messy, multi-format evidence |
| 3 | **Credential Sentinel** — Autonomous credential and integration monitor | You can deploy AI as a production operator with judgment and bounds |

Each week compounds. Week 2 extends Week 1's retrieval and ingestion pipeline. Week 3 extends Week 2's grounding and citation infrastructure into a multi-tool autonomous agent. Do not treat these as three separate projects.

---

## How You Are Evaluated

This cohort beta-tests **Kiln** — a CLI-first grading platform that captures how you work with AI, not just what you ship.

Traditional grading looks at your repo and a demo video. Kiln captures the full execution trail: every LLM prompt, every tool call, every failure and recovery, every test result, and every code quality signal. The output is a structured one-sheet that explains not just what you shipped, but how you reasoned, where you struggled, and whether you demonstrated production-ready judgment.

After a final submission is graded, Kiln may dispatch your one-sheet and AI usage snapshot to your cohort's Kiln Portal, where it can generate tailored technical interview questions and trigger a follow-up video interview workflow. Checkpoints and early submissions are never dispatched — they stay formative.

**You do not change how you work.** Kiln runs a lightweight capture proxy in the background. You write code, use Claude, use Cursor, use whatever tools you prefer. Kiln watches silently and grades asynchronously.

### The Five Grading Axes

| Axis | Weight | What Kiln Measures |
|------|--------|--------------------|
| **Ships** | 30% | Does the product work end-to-end when the grader clones and runs it? Docker build, health check, test pass rate. |
| **Resilience** | 25% | Does it handle chaos monkey inputs without crashing or hallucinating? Kiln's chaos engineering tools inject faults locally via the visible weekly chaos profile you can run yourself. **Final grading also runs an additional hidden chaos set** — unseen test cases stored server-side that use the same fault categories and steady-state criteria as the visible profile but different target/timing/intensity permutations. The hidden set runs ONLY on your final submission (not early, not checkpoints). Resilience is scored primarily from hidden-set results to reward real fault-tolerance over overfitting to known tests. |
| **Engineering Quality** | 20% | CI, tests, typed code, scoped permissions, audit trail. SonarQube static analysis provides deterministic metrics; Claude evaluates architectural quality. |
| **AI Judgment** | 15% | Does the system surface ambiguity instead of guessing? Does it refuse when it should? Your captured AI interaction logs reveal your prompting strategy and the system's decision quality. |
| **Compounding** | 10% | Does this week's code cleanly extend last week's? Shared infrastructure, consistent patterns, no copy-paste forks. |

### MVP Gate

Every week has an MVP deadline (typically 24 hours after assignment drop). The MVP is binary — **pass or fail, no partial credit.** Every bullet in the MVP Requirements section is a hard gate. If one fails, the week fails. Read the MVP list before you write a single line of code.

### Checkpoints

At any point during the week, you can request a **checkpoint** — a fast, formative assessment of your current progress against the rubric. Kiln runs a reduced version of the grading pipeline and returns rubric-aware gap analysis in under 90 seconds.

Checkpoints tell you where you stand while there is still time to course-correct. They do not count as grades. Use them aggressively.

---

## Environment Prerequisites

Before running `kiln init`, verify you have the following installed:

| Tool | Minimum Version | Check Command |
|------|----------------|---------------|
| Docker | 27.0+ | `docker --version` |
| Docker Compose | 2.20+ | `docker compose version` |
| Git | 2.40+ | `git --version` |
| Bun | 1.x+ | `bun --version` |

**Project-specific runtimes.** Your project may declare additional toolchains in its manifest files (`package.json` for Node, `requirements.txt` / `pyproject.toml` for Python, `go.mod` for Go, `Cargo.toml` for Rust, `Gemfile` for Ruby). `kiln init` and `kiln doctor` scan these manifests and verify the declared runtime is installed at the minimum version. Install whatever your project needs before running `kiln audit` — a tool like [`mise`](https://mise.jdx.dev/) or [`asdf`](https://asdf-vm.com/) makes this painless. If you are on macOS, Homebrew works for most cases (`brew install node@20 python@3.12 go`).

You will also need:

- **An Anthropic API key** — provided to you via the cohort Slack channel. Kiln validates this key with a live test call during `init`.
- **A GitLab account** — your cohort's GitLab group will be shared before Week 1. All repos live here.
- **Docker Desktop, OrbStack, or Docker Engine** — Kiln detects your container runtime automatically. OrbStack is recommended on macOS for performance.

---

## Setting Up Kiln

### Step 1: Install Kiln CLI

```bash
bun install -g @kiln/cli
kiln --version
```

### Step 2: Initialize

```bash
kiln init
```

This command:

1. Checks your Docker, Git, and runtime versions
2. Prompts for your Anthropic API key and validates it with a live test call
3. Authenticates you against the Kiln API using your cohort credentials
4. Retrieves your cohort assignment, current week, and available projects
5. Installs shell completions
6. Writes your local config to `~/.kiln/config.json`

If anything fails, Kiln tells you exactly what to fix. If you need to re-run later: `kiln init --reset`.

### Step 3: Scaffold Your Project

`kiln scaffold` has two modes.

**Greenfield** — starting from an empty directory:

```bash
kiln scaffold --week 1
cd week-01
```

Produces a full project tree with `docker-compose.yml`, `.kiln/` (proxy source, rubric, chaos config), `.env`, `spec.md`, `rubric.yml`, `Makefile`, and `README.md`. The scaffold is cohort-aware — your rubric and project config are pulled from the Kiln API, not just local templates.

**Brownfield** — starting from an existing repo (this is the common case):

```bash
cd my-existing-project
kiln scaffold --week 1 --adopt
```

This installs only the Kiln bits into your existing tree:

- `.kiln/` — proxy source code, proxy config, rubric, chaos config
- `.env` — merged (existing keys preserved, proxy URLs appended)
- `spec.md`, `rubric.yml` — only if they don't already exist
- `Makefile` — Kiln targets merged in if a `Makefile` already exists

**Kiln will never overwrite your existing `Dockerfile`, `docker-compose.yml`, `package.json`, or source files.** Anything already present is reported as `skipped (exists)` and left alone. If you need to regenerate a specific file from the template, pass `--force` — but you are responsible for merging the changes yourself.

If your repo does **not** already ship a `Dockerfile` or `docker-compose.yml`, `kiln scaffold` will print a warning. See the next section.

### Step 3a: Adding a Dockerfile to an Existing Project

Grading runs `docker compose build` on a clean machine. If your repo does not build this way, it does not ship — and `kiln audit` will hard-fail before you can submit.

Every project needs, at minimum:

1. A `Dockerfile` (or `Containerfile`) at the repo root that produces a runnable image
2. A `docker-compose.yml` (or `compose.yaml`) that builds that image and wires up any dependencies (database, cache, queue, etc.)

The Kiln capture proxy is a separate service in `compose.yml` (the template under `.kiln/templates/docker-compose.yml` shows how to wire it in). Copy the `kiln-proxy` service block into your own `docker-compose.yml` and point your application's AI SDKs at `localhost:9100` / `9101` / `9102` via `.env`.

Run `kiln doctor` after you add the Dockerfile — it will tell you if anything is still missing. Run `kiln audit` once you think it's working — it runs the same `docker compose build` the grader will run.

### Step 4: Start the Capture Proxy

```bash
docker compose up -d
```

The capture proxy starts three listeners:

| Port | Provider | What It Captures |
|------|----------|-----------------|
| 9100 | Anthropic | All Claude API calls |
| 9101 | OpenAI | All OpenAI API calls |
| 9102 | Google | All Google AI calls |

Point your tools at these ports instead of the upstream APIs. The scaffold's `.env` file does this automatically for most setups. The proxy forwards everything upstream transparently with less than 5ms overhead. Every request and response is logged to `.kiln/harness.jsonl`.

**Verify it is working:**

```bash
kiln proxy status
```

You should see interaction counts increasing as you work.

### Step 5: Work Normally

Write code. Use Claude Code, Cursor, or any AI tool you prefer. Build your product. The proxy captures everything in the background.

### Step 6: Check Your Progress (Anytime)

```bash
kiln checkpoint
```

This pushes your current state, runs a soft audit, and returns a formative assessment in under 90 seconds. You will see:

- **Evaluation coverage** — what Kiln could and could not assess (if your Docker build is broken, it tells you)
- **Per-criterion gap status** — on-track, at-risk, not-started, or blocked for each rubric criterion
- **AI usage snapshot** — how you have been using AI tools so far
- **Top 3 priorities** — what to focus on next

Checkpoints are formative only. They do not count as grades. Run them as often as you want.

### Step 7: Run Chaos Engineering

```bash
# Inject 500ms latency on your database for 60 seconds
kiln chaos latency --target postgres --delay 500ms --duration 60s --verify

# Kill a container and watch recovery
kiln chaos kill --target app --in 30s

# Run the full weekly VISIBLE chaos profile (the set you can iterate against locally)
kiln chaos profile --week 1
# Note: final grading additionally runs a HIDDEN chaos set that you cannot see or pre-run.
# Same fault categories, same steady-state criteria, different permutations. Build for the
# general case, not the specific visible cases.
```

The `--verify` flag checks your system's steady state before and after the fault. Chaos results are saved and become part of your grading evidence.

### Step 8: Audit Before Submitting

```bash
kiln audit
```

This validates:

- All required files are present
- Docker builds successfully
- Proxy capture logs are intact and properly formatted
- No secrets are exposed in Docker layers
- CI pipeline is configured

Every failure includes a fix command. Run `kiln audit --fix` for trivial fixes.

### Step 9: Submit

You have two submission stages each week:

```bash
# Thursday 11:59 PM CT — early submission (dress rehearsal)
kiln submit --stage early

# Saturday 11:59 PM CT — final submission (graded)
kiln submit --stage final
```

**Early submission** runs the full grading pipeline — audit, build, tests, visible chaos profile, code analysis, one-sheet generation — EXCEPT the hidden chaos set. You get back a complete one-sheet with a Resilience axis marked `"dress_rehearsal"`. Use it to course-correct before Saturday. Early is optional but strongly recommended.

**Final submission** runs everything, including the hidden chaos set. This is the graded run. The Resilience axis score comes primarily from hidden-set performance.

Both stages run `kiln audit`, push to GitLab, and return a job ID. Check status with:

> A successful final submission may also trigger downstream Portal integrations when your cohort has them configured (for example, generating tailored interview questions from your one-sheet). This happens after grading and never blocks your results. Early submissions do not trigger Portal dispatch.

```bash
kiln status
kiln results   # when grading completes
```

If you omit `--stage`, `kiln submit` defaults to `final`. Running `--stage early` after the Thursday deadline, or `--stage final` after the Saturday deadline, will be rejected by the API.

---

## Weekly Rhythm

| Day | Activity |
|-----|----------|
| **Monday** | Assignment drops. Read the spec. Complete the Pre-Search checklist. `kiln scaffold --week N`. |
| **Tuesday** | MVP deadline (24 hours after drop). Hard gate — all MVP requirements must pass. |
| **Wednesday** | Build. Run `kiln checkpoint` regularly. Run the visible chaos profile locally. |
| **Thursday 11:59 PM CT** | **Early submission deadline.** `kiln submit --stage early`. Full grading pipeline runs EXCEPT the hidden chaos set. You get back a complete one-sheet (Resilience marked `dress_rehearsal`). Use it to course-correct Friday and Saturday. Optional but strongly recommended. |
| **Friday** | Act on early submission feedback. Harden against the general fault case, not just the visible chaos profile — the hidden set runs on Saturday. More checkpoints as needed. |
| **Saturday 11:59 PM CT** | **Final submission deadline.** `kiln audit` then `kiln submit --stage final`. Full pipeline including the hidden chaos set. This is your graded run. Write your postmortem. |

---

## What "Ship" Means

"Ship" does not mean "it runs on my machine." It means:

1. Your repo contains a working `Dockerfile` **and** a `docker-compose.yml`. `docker compose build` succeeds on a clean machine. No Dockerfile, no ship — `kiln audit` will block you before `kiln submit` even runs.
2. A reviewer can clone, install, and run it with `docker compose up`
3. The chaos monkey grader exercises edge cases — both the **visible** chaos profile you can run locally AND a **hidden** chaos set you have never seen — and the system handles them gracefully. Design for the general fault class, not the specific visible tests. A system that passes the visible profile but cracks under the hidden set did not ship.
4. Logs and observability are present — every AI decision is traceable via the Kiln capture proxy
5. The product has a user-facing surface (CLI, API, or dashboard) that a non-engineer could understand

---

## Troubleshooting

**Something is not working:**

```bash
kiln doctor
```

This re-runs all environment checks, verifies API connectivity, and reports your cohort info.

**Proxy is not capturing:**

```bash
kiln proxy status
```

Verify your tools are pointed at `localhost:9100` (Anthropic), `localhost:9101` (OpenAI), or `localhost:9102` (Google). Check your `.env` file.

**Docker build is failing:**

Your Dockerfile must build cleanly. The grading pipeline clones your repo and runs `docker compose build`. If it does not build on a clean machine, it does not ship.

- **No `Dockerfile` at all?** See *Adding a Dockerfile to an Existing Project* above. This is a hard gate — `kiln audit` will not pass without one.
- **No `docker-compose.yml`?** Same — both are required. Start from the template at `.kiln/templates/docker-compose.yml` and wire in your services.
- **Build works locally but `kiln audit` fails?** `kiln audit` runs `docker compose build` with no cache and no host mounts. Anything relying on files outside the build context (e.g. a `node_modules` on your host) will miss. Add it to the build context or the image.
- **Missing language runtime?** `kiln doctor` checks your host toolchain against what your project declares in `package.json`, `pyproject.toml`, `go.mod`, etc. If it reports a version mismatch, install the right version (`mise install` or equivalent) before re-running `kiln audit`.

**Checkpoint is stuck:**

Checkpoints target under 90 seconds. If the API is unreachable, Kiln retries 3 times and then reports a clear error. Run `kiln doctor` to check connectivity.

---

## Tools & Stack

You may use any language and framework. The curriculum examples use TypeScript and the Claude Agent SDK. The product requirements are stack-agnostic — what matters is the output.

**Required infrastructure for all three weeks:**

- Git + GitLab (all repos must be in your cohort's GitLab group)
- Docker (every submission must include a working `docker-compose.yml`)
- Kiln CLI (capture proxy, chaos tools, audit, submit)
- A structured logging system (JSONL minimum)
- CI pipeline (GitLab CI)

**Provided to you:**

- API keys for Claude, OpenAI, and Cohere (for embedding comparisons)
- Kiln CLI and capture proxy (installed during setup)
- Source material packages for each week (distributed Monday via Slack)
- A shared eval harness repo with chaos monkey test fixtures
- Slack channel for cohort communication
- Office hours: 30 minutes daily, 2:00 PM CT

---

## Kiln Command Reference

| Command | What It Does |
|---------|-------------|
| `kiln init` | One-time setup: validate environment, authenticate, configure |
| `kiln scaffold --week N` | Generate project directory for week N (greenfield) |
| `kiln scaffold --week N --adopt` | Install Kiln into an existing repo without overwriting Dockerfile/compose/source |
| `kiln proxy start` | Start the AI capture proxy |
| `kiln proxy stop` | Stop the capture proxy |
| `kiln proxy status` | Show proxy health and interaction counts |
| `kiln chaos latency` | Inject network latency on a target container |
| `kiln chaos kill` | Kill a target container |
| `kiln chaos stress` | CPU/memory stress on a target container |
| `kiln chaos disconnect` | Network disconnect on a target container |
| `kiln chaos profile --week N` | Run the full VISIBLE chaos profile for week N (hidden set is server-side and runs only on final grading) |
| `kiln checkpoint` | Request formative feedback on current progress |
| `kiln audit` | Validate submission readiness |
| `kiln logs analyze` | Analyze your AI interaction patterns |
| `kiln submit --stage early` | Thursday dress rehearsal — full grading pipeline minus hidden chaos set |
| `kiln submit --stage final` | Saturday graded submission — full pipeline including hidden chaos set (default if `--stage` omitted) |
| `kiln status` | Check grading pipeline status |
| `kiln results` | View grading results |
| `kiln doctor` | Troubleshoot environment issues |
| `kiln config list` | View current configuration |

All commands support `--ci` for machine-readable output and `--verbose` for detailed diagnostics.

---

## One Last Thing

The remote phase is designed to be hard. The products are real. The deadlines are tight. The chaos monkey does not care about your feelings.

But the system is fair. Every grading criterion is published in your `rubric.yml` before you write a line of code. Checkpoints give you feedback while there is still time to act on it. The capture proxy means your AI collaboration is visible and valued — not hidden and suspicious. When Kiln routes your one-sheet downstream (for example, to your cohort's Portal), it uses the same evidence you already saw in your grading results — no hidden signals.

Ship under pressure. That is the skill.

Welcome to the Kiln.
