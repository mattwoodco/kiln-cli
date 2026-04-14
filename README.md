# Kiln

CLI-first grading platform that captures how developers work with AI — not just what they ship. Students work in their own repos behind a capture proxy; Kiln runs grading and formative checkpoints asynchronously and emits a structured one-sheet per submission.

This repo is the full monorepo: CLI, HTTP API, Temporal grading worker, Go capture proxy, and supporting infra.

## What's in the box

| Workspace         | Purpose                                                             |
| ----------------- | ------------------------------------------------------------------- |
| `apps/cli`        | `kiln` oclif CLI (the binary students install and run)              |
| `apps/api`        | Fastify HTTP API — auth, cohorts, submissions, checkpoints, usage   |
| `apps/grading`    | Temporal worker — grading + checkpoint workflows and activities     |
| `apps/proxy`      | Go reverse proxy that captures Anthropic / OpenAI / Google traffic  |
| `packages/shared` | `@kiln/shared` — Zod schemas and shared types (consumed as TS src)  |
| `infra/`          | `docker-compose.infra.yml` — Temporal, Postgres, Redis, SonarQube   |

Plan-vs-actual path mapping lives in `STRUCTURE.md`. The student-facing setup guide lives in `research/Kiln CLI (Beta) - 02 - Setup docs/kiln-beta-pre-setup.md`.

## Prerequisites

| Tool           | Version           |
| -------------- | ----------------- |
| Bun            | 1.3+              |
| Node.js        | 20+ (for runtime) |
| Docker         | 27+               |
| Docker Compose | 2.20+             |
| Go             | 1.22+ (proxy)     |

You also need an `ANTHROPIC_API_KEY` for live grading. Tests run fine with `MOCK_LLM=1`.

## First-time admin setup

```bash
# 1. Clone and install
git clone <this-repo> kiln && cd kiln
bun install

# 2. Start infra (Temporal, Postgres, Redis, SonarQube)
docker compose -f infra/docker-compose.infra.yml up -d

# 3. Push the DB schema
cd apps/api
DATABASE_URL=postgres://kiln:kiln@localhost:5432/kiln \
  bunx drizzle-kit push --force
cd ../..

# 4. Typecheck / lint / test / build everything
bun run ci
```

If `localhost:5432` resolves to a host Postgres instead of the container, point `DATABASE_URL` at the container's bridge IP — see `ISSUES.md` Issue 7.

## Running the services

Each service reads config from env vars. Defaults are safe for a single-host dev box.

```bash
# API (Fastify, port 4000)
DATABASE_URL=postgres://kiln:kiln@localhost:5432/kiln \
TEMPORAL_ADDRESS=localhost:7233 \
JWT_SECRET=change-me \
STORAGE_PATH=./data \
bunx turbo dev --filter=@kiln/api

# Grading worker (Temporal)
DATABASE_URL=postgres://kiln:kiln@localhost:5432/kiln \
TEMPORAL_ADDRESS=localhost:7233 \
ANTHROPIC_API_KEY=sk-ant-... \
STORAGE_PATH=./data \
SONAR_URL=http://localhost:9000 \
SONAR_TOKEN=<token-from-sonar-ui> \
bunx turbo dev --filter=@kiln/grading

# CLI (run from repo)
bun run apps/cli/bin/run.js --help
```

Temporal UI: <http://localhost:8080>. SonarQube: <http://localhost:9000> (first login `admin`/`admin`, then issue a token and set `SONAR_TOKEN`).

## Environment variables

| Var                      | Used by        | Default                                       |
| ------------------------ | -------------- | --------------------------------------------- |
| `DATABASE_URL`           | api, grading   | `postgres://kiln:kiln@localhost:5432/kiln`    |
| `TEMPORAL_ADDRESS`       | api, grading   | `localhost:7233`                              |
| `TEMPORAL_NAMESPACE`     | grading        | `default`                                     |
| `JWT_SECRET`             | api            | `dev-kiln-secret-change-me` (change in prod)  |
| `GITLAB_WEBHOOK_TOKEN`   | api            | empty (required for GitLab webhooks)          |
| `STORAGE_PATH`           | api, grading   | `./data`                                      |
| `ANTHROPIC_API_KEY`      | grading        | required for live LLM calls                   |
| `MOCK_LLM`               | grading        | `1` disables live calls (tests)               |
| `SONAR_URL`              | grading        | `http://localhost:9000`                       |
| `SONAR_TOKEN`            | grading        | required for real SonarQube scans             |
| `KILN_SECRET_DIR`        | grading        | dir holding dispatch target secrets           |
| `PORT`                   | api            | `4000`                                        |

## Test and CI

```bash
bun run ci                 # typecheck + lint + test + build across workspaces
bun run ci:regression      # gold-set regression suite (grading)
```

219-test baseline is green against `MOCK_LLM=1`. See `ISSUES.md` for deferred work and known gaps (live LLM JSON parsing, Pumba/Toxiproxy live paths, Temporal schedules, portal dispatch, etc.).

## Where to look next

- `STRUCTURE.md` — directory layout and plan-path mapping
- `PROGRESS.md` — phase-by-phase execution log
- `ISSUES.md` — open, fixed, and deferred issues with re-validation steps
- `research/Kiln CLI (Beta) - 02 - Setup docs/kiln-beta-pre-setup.md` — student pre-setup guide (what `kiln init`, `scaffold`, `checkpoint`, `audit`, `submit` do)
- `research/Kiln CLI (Beta) - 01 - Plan/kiln-beta-execution-plan.md` — full execution plan
