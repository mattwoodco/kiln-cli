**Kiln** — grades how devs work with AI, not just what they ship.

A CLI proxy silently captures all LLM interactions while students work. On submit, a Temporal pipeline runs tests, SonarQube static analysis, and Claude-powered review against a per-cohort rubric. Output is a structured one-sheet with scores, evidence, and coaching notes.

Students can also request **checkpoints** mid-project — a reduced pipeline returns rubric-aware gap analysis in <90s using best-effort build/test and a single Sonnet pass. Formative only, doesn't count as a grade.

Every pipeline run (grading + checkpoint) tracks token usage, cost, and cache efficiency. Admins get per-cohort spend breakdowns, anomaly alerts, and CSV export via the CLI.

MVP is CLI + proxy + grading pipeline + checkpoints + usage metrics. No dashboard yet. Three vendors (Anthropic, Fly, GitLab).
