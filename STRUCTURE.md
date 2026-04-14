# Repository Structure

This repo uses an `apps` / `packages` / `infra` split that differs from the execution plan's flat `packages/*` layout. The mapping below is load-bearing for every downstream phase — when the plan says `packages/cli`, we mean `apps/cli`, and so on.

## Layout

```
kiln/
  apps/
    cli/            # oclif CLI (the `kiln` binary)         [plan: packages/cli]
    api/            # Fastify HTTP server                    [plan: packages/api]
    grading/        # Temporal worker + workflows + acts     [plan: packages/grading]
    proxy/          # Go reverse proxy (Anthropic/OpenAI/Google) [plan: packages/proxy]
  packages/
    shared/         # @kiln/shared — Zod schemas + types     [plan: packages/shared]
  infra/
    docker-compose.infra.yml   # Temporal, Postgres, Redis, SonarQube
  research/
    Kiln CLI (Beta) - 01 - Plan/
      kiln-beta-execution-plan.md
  PROGRESS.md       # Append-only execution log
  ISSUES.md         # Issue tracker
  STRUCTURE.md      # This file
```

## Why the deviation

- Runnable workspaces (processes with a main entry) live in `apps/`.
- Reusable libraries live in `packages/`.
- Dev infrastructure (Docker Compose, seed scripts) lives in `infra/`.
- This matches the user's requested `/apps /packages /infra` top-level split.

## Workspace glob

Root `package.json` declares:

```json
"workspaces": ["apps/*", "packages/*"]
```

Turborepo sees all six workspaces as peers.

## Cross-package imports

- `@kiln/shared` is consumed as **TypeScript source**. It has no build step and is not compiled to `dist/`.
  - `packages/shared/package.json` uses `"main": "src/index.ts"` and `"types": "src/index.ts"`.
  - Downstream apps import from `@kiln/shared` and their own tsc reads the `.ts` files directly.
  - This keeps iteration fast and avoids a turbo build-order hop for schema changes.
- All other workspaces reference `@kiln/shared` as `"workspace:*"`.

## Plan → actual path mapping

| Plan path                             | Actual path                     |
| ------------------------------------- | ------------------------------- |
| `packages/cli`                        | `apps/cli`                      |
| `packages/api`                        | `apps/api`                      |
| `packages/grading`                    | `apps/grading`                  |
| `packages/proxy`                      | `apps/proxy`                    |
| `packages/shared`                     | `packages/shared` (unchanged)   |
| `docker-compose.infra.yml` (at root)  | `infra/docker-compose.infra.yml`|

When the plan references files like `packages/grading/src/activities/...`, read as `apps/grading/src/activities/...`. The `.gitlab-ci.yml` regression rules already reflect this mapping.
